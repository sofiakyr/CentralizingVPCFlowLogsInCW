const AWS = require("aws-sdk");
const zlib = require("zlib");
const s3 = new AWS.S3();
const cloudwatchlogs = new AWS.CloudWatchLogs();
// gets its value from clouformation parameter
const cwLogGroupName = process.env.LOGGROUP;
// reusing the lambda log stream names in order to manage creation of new streams when nessasery
const cwLogStreamName = process.env.AWS_LAMBDA_LOG_STREAM_NAME || "undefined-stream";
// used to scan existing log streams in order to see if current log stream name exists
const cwLogDescribeLimit = 50; // Default is 50
const defaultLogFormat = "${account-id} ${action} ${bytes} ${dstaddr} ${dstport} ${end} ${instance-id} ${interface-id} ${log-status} ${packets} ${pkt-dstaddr} ${pkt-srcaddr} ${protocol} ${srcaddr} ${srcport} ${start} ${subnet-id} ${tcp-flags} ${type} ${version} ${vpc-id}";
// enviroment variable for custom log format, gets its value from cloudformation template
const logFormat = process.env.LOG_FORMAT || defaultLogFormat;


// receives a custom format "${account-id} ${action} ${bytes}... ", makes it in a list of contencts
// [account-id, action, byes...], using regex to select them
const getLogFormatAsArray = () => {
    const extractFormatRe = /\${([a-zA-Z-]+)}/g;
    const matches = [];
    let r;
    do {
        r = extractFormatRe.exec(logFormat);
        if (r) matches.push(r[1]);
    } while (r);
    return(matches);
};

const processVPCFlowLog = (message, matches) => {
    // takes on a message, which is a line of the logs from s3:  677731379415 REJECT 40 172.31.80.41....
    // make it in array of values
    const m = message.split(" ");
    // makes previous list to camel case instead of -, so that wew can then make the right
    // attribute names for the JSON  [account-id, action, byes] ===>  [accountId, action, byes]
    const toCamelCase = (s) => s.replace(/-([a-z])/g, (g) => g[1].toUpperCase());
    const formatted = matches.map(toCamelCase); 
    const object = {};
    //we actually make the object using the array of formated attributes names (from the custom formated variable) 
    //and the array of logs from s3
    // {"accountId":"753390936611","action":"REJECT","bytes":"44"...
    formatted.forEach((key, i) => { object[key] = m[i]; });
    return object;
};

// this function is used for managing the logs Streams
const ensureLogStream = async () => {
    console.log("Getting existing log stream details");
    const cwDescribeParams = {
        logGroupName: cwLogGroupName,
        logStreamNamePrefix: cwLogStreamName,
        limit: cwLogDescribeLimit,
    };
    // gets 50 most recent existing log stream names
    const logStreamData = await cloudwatchlogs.describeLogStreams(cwDescribeParams).promise();

    console.log("Checking for matching existing log stream");
    // see if currect lambda stream name is whithin those 50
    const matches = logStreamData.logStreams.filter(ls => ls.logStreamName === cwLogStreamName);
    if (matches.length === 0) {
        // if not name new one
        console.log("No matching stream found, creating new stream");
        const params = {
            logGroupName: cwLogGroupName,
            logStreamName: cwLogStreamName
        };
        await cloudwatchlogs.createLogStream(params).promise(); // Returns empty object so response not needed
        return null;
    } else {
        console.log("Matching stream found");
        // else use existing one, to do so we use the SequenceToken, which is like a unique id, and is returned from
        // described logs
        // learn more here https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/CloudWatchLogs.html
        return  matches[0].uploadSequenceToken;
    }
};

// this is used to handle the S3 event once it is derived from the SQS event
const handleS3Event = async (record) => {
    // we need to ensure it is an s3 event
    if (typeof record.s3 !== "object" ) {
        const error = "S3 Record was not an object";
        console.error(error);
        return { error };
    }
    // we need to check it has an object, sometimes when empty folders are created we wont get a key
    // we need to avoid running the rest of the code in such a case
    if (typeof record.s3.object.key !== "string") {
        console.log("No key found, skipping");
        return;
    }
    const Key = record.s3.object.key;
    const Bucket = record.s3.bucket.name;
    console.log(`Getting S3 data from bucket: ${Bucket}, at key: ${Key}`);
    // await for s3 data to be read
    const s3Data = await s3.getObject({ Bucket, Key }).promise();
    console.log("Data received");
    // check if data is empty
    if (s3Data.Body.toString().split("\n")[0].trim() === "") {
        const message = "S3 Data body was empty, skipping";
        console.log(message);
        return;
    }
    // unzip the data, data is compressed in S3
    const buffer = new Buffer.from(s3Data.Body, "base64");
    const decompressed = zlib.gunzipSync(buffer);
    // make data in an array of logs, each log is a line in S3
    const messageLines = decompressed.toString().split("\n");
    // now set the attributes names for the JSON object
    const formatArray = getLogFormatAsArray();
    // we can now remove the first line in the S3 logs, as it is the titles of logs
    // account-id action bytes dstaddr dstport..., we store the titles in the const
    const logFileFormat = messageLines.shift();
    // we check that the titles much the iput of the expected format
    if (logFileFormat !== formatArray.join(" ")) {
        const error = "Format in Lambda and format in the log file differ";
        console.error(error);
        console.log("Format in Lambda:", formatArray);
        console.log("Format in log file:", logFileFormat);
        return { error };
    }

    // we need to set the message to be sent to CW,
    // this needs to contain a timestamp and a message of JSON format with our data
    const processedData = messageLines
        .filter((message) => message !== "")
        .map((message) => ({
            timestamp: Date.now(),
            message: JSON.stringify(processVPCFlowLog(message, formatArray))
        }));

    // then we need to identify in which stream we need to sent the logs to
    const sequenceToken = await ensureLogStream();

    // to sent the logs we need the logGroupName, the data (logEvent), the logStreamName (which we have from the lambda),
    // and the stream sequence token (which we will get either from the existing stream or from the one we just created)
    const putLogsPayload = {
        logGroupName: cwLogGroupName,
        // this is the lambda Stream name (whether existing or new)
        logStreamName: cwLogStreamName,
        logEvents: processedData
    };
    if (sequenceToken) {
        console.log("Attaching existing sequence token");
        // add the token, this is returned from the ensureLogStream function
        putLogsPayload.sequenceToken = sequenceToken;
    } else {
        // if you just created the log stream the token is given for you and the SDk handles this for you,
        // so we dont need to add it 
        console.log("Using sequenceToken provided from creating a new log stream");
    }
    console.log(`Uploading logs to aggregated CloudWatch Log Group: ${cwLogGroupName}, in stream: ${cwLogStreamName}`);
    // once we have everything we sent the logs
    await cloudwatchlogs.putLogEvents(putLogsPayload).promise();
    console.log("Logs successfully uploaded");
    return "success";
};

// gets an SQS event and returns the body, which we expect it to be a string containing
// the S3 event
const handleSQSEvent = async (eventBodyString) => {
    try {
        // parse String of S3 event in JSON
        const parsedBody = JSON.parse(eventBodyString); 
        if (!Array.isArray(parsedBody.Records)) {
            console.log("There were no records, skipping");
            console.log(parsedBody);
            return;
        }
        // sends S3 events to handleS3Event, which will do the rest of the processing
        const allEvents = parsedBody.Records.map(r => handleS3Event(r));
        return await Promise.all(allEvents.map(handleRejection));
    } catch (error) {
        console.log("There was an issue creating S3 promises:", error);
        console.log("Event String:", eventBodyString);
        return { error };
    }
};

// To avoid Promise's Fail Fast
// if any of the promisses fail the rest will be able to proceed
const handleRejection = (p) => p.catch(error => ({ error }));

// handler function, receives all records from batches and sends to handleSQS function
exports.handler = async (event) => {
    const allEvents = event.Records.map (r => {
        if (typeof r.body == "string" && r.body.trim() != "") {
            return handleSQSEvent(r.body);
        } else {
            console.info("Unrecognized body:", r.body);
            console.info("Skipping");
        }
    });

    const allResults = await Promise.all(allEvents.map(handleRejection));
    console.log(JSON.stringify(allResults));
    return "success";
};