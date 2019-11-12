const AWS = require("aws-sdk");
const zlib = require("zlib");
const s3 = new AWS.S3();
const cloudwatchlogs = new AWS.CloudWatchLogs();
const cwLogGroupName = process.env.LOGGROUP;
const cwLogStreamName = process.env.AWS_LAMBDA_LOG_STREAM_NAME || "undefined-stream";
const cwLogDescribeLimit = 50; // Default is 50
const defaultLogFormat = "${account-id} ${action} ${bytes} ${dstaddr} ${dstport} ${end} ${instance-id} ${interface-id} ${log-status} ${packets} ${pkt-dstaddr} ${pkt-srcaddr} ${protocol} ${srcaddr} ${srcport} ${start} ${subnet-id} ${tcp-flags} ${type} ${version} ${vpc-id}";
const logFormat = process.env.LOG_FORMAT || defaultLogFormat;

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
    const m = message.split(" ");
    const toCamelCase = (s) => s.replace(/-([a-z])/g, (g) => g[1].toUpperCase());
    const formatted = matches.map(toCamelCase); 
    const object = {};
    formatted.forEach((key, i) => { object[key] = m[i]; });
    return object;
};

const ensureLogStream = async () => {
    console.log("Getting existing log stream details");
    const cwDescribeParams = {
        logGroupName: cwLogGroupName,
        logStreamNamePrefix: cwLogStreamName,
        limit: cwLogDescribeLimit,
    };
    const logStreamData = await cloudwatchlogs.describeLogStreams(cwDescribeParams).promise();

    console.log("Checking for matching existing log stream");
    const matches = logStreamData.logStreams.filter(ls => ls.logStreamName === cwLogStreamName);
    if (matches.length === 0) {
        console.log("No matching stream found, creating new stream");
        const params = {
            logGroupName: cwLogGroupName,
            logStreamName: cwLogStreamName
        };
        await cloudwatchlogs.createLogStream(params).promise(); // Returns empty object so response not needed
        return null;
    } else {
        console.log("Matching stream found");
        return  matches[0].uploadSequenceToken;
    }
};

const handleS3Event = async (record) => {
    if (typeof record.s3 !== "object" ) {
        const error = "S3 Record was not an object";
        console.error(error);
        return { error };
    }
    if (typeof record.s3.object.key !== "string") {
        console.log("No key found, skipping");
        return;
    }
    const Key = record.s3.object.key;
    const Bucket = record.s3.bucket.name;
    console.log(`Getting S3 data from bucket: ${Bucket}, at key: ${Key}`);
    const s3Data = await s3.getObject({ Bucket, Key }).promise();
    console.log("Data received");
    const s3DataContent = s3Data.Body.toString().split("\n");
    if (s3DataContent[0].trim() === "") {
        const message = "S3 Data body was empty, skipping";
        console.log(message);
        return;
    }
    const buffer = new Buffer.from(s3Data.Body, "base64");
    const decompressed = zlib.gunzipSync(buffer);
    const messageLines = decompressed.toString().split("\n");
    const formatArray = getLogFormatAsArray();
    const logFileFormat = messageLines.shift();
    if (logFileFormat !== formatArray.join(" ")) {
        const error = "Format in Lambda and format in the log file differ";
        console.error(error);
        console.log("Format in Lambda:", formatArray);
        console.log("Format in log file:", logFileFormat);
        return { error };
    }

    const processedData = messageLines
        .filter((message) => message !== "")
        .map((message) => ({
            timestamp: Date.now(),
            message: JSON.stringify(processVPCFlowLog(message, formatArray))
        }));

    const sequenceToken = await ensureLogStream();

    const putLogsPayload = {
        logGroupName: cwLogGroupName,
        logStreamName: cwLogStreamName,
        logEvents: processedData
    };
    if (sequenceToken) {
        console.log("Attaching existing sequence token");
        putLogsPayload.sequenceToken = sequenceToken;
    } else {
        console.log("Using sequenceToken provided from creating a new log stream");
    }
    console.log(`Uploading logs to aggregated CloudWatch Log Group: ${cwLogGroupName}, in stream: ${cwLogStreamName}`);
    await cloudwatchlogs.putLogEvents(putLogsPayload).promise();
    console.log("Logs successfully uploaded");
    return "success";
};

const handleSQSEvent = async (eventBodyString) => {
    try {
        const parsedBody = JSON.parse(eventBodyString); // Parse could fail
        if (!Array.isArray(parsedBody.Records)) {
            console.log("There were no records, skipping");
            console.log(parsedBody);
            return;
        }
        const allEvents = parsedBody.Records.map(r => handleS3Event(r));
        return await Promise.all(allEvents.map(handleRejection));
    } catch (error) {
        console.log("There was an issue creating S3 promises:", error);
        console.log("Event String:", eventBodyString);
        return { error };
    }
};

// To avoid Promise's Fail Fast
const handleRejection = (p) => p.catch(error => ({ error }));


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