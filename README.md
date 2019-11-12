# CentralizingVPCFlowLogsInCW
All nessasary code and documentation for a simple and scalable aproach for Centralized VPC flow logs, with custom format, in an aggregated Cloudwatch Log Group

## Solution Requirements:

*	Access to all VPC flow logs for chosen user/account, in a single place, without additional logging requirements
*	No complex SQL to query the logs
*	Ability to handle hundreds of accounts, each having multiple VPC’s
* Simple to implement and maintain
*	Includes additional metadata/costume format for the logs
*	Supports incoming logs from different regions


## Design:
*	All accounts are sending logs, directly to the master’s account bucket, which has the appropriate bucket policies to accept the logs to be written by the log service. The logs arrive in batches of max 75KB.
*	SQS is used to queue the requests of any PUT event on the bucket. From, there the Lambda picks them up for processing. SQS can further batch the events and handles retries. Failed events are pushed to a dead letter queue for manual processing.
*	The lambda executes the following steps, in summary:
1.	Unzip the logs
2.	Check if they are in the correct custom format
3.	Builds the appropriate structure so as to send them to CW, using the SDK. Logs are required to be on JSON object with appropriate attribute names, so that they can be quarriable by CW insights.
4.	Manages the creation of new Log Streams when necessary. The SDK requires you to send logs to a specific log Stream, however log streams can time out and you need to manage this. We manage this by reusing the lambda’s log stream name, using the environment variable. We check if the current name exists, is so we sent logs there, otherwise we make a new one with that name.

## How to run:
1.	Run the macro.yaml in CloudFormation. 

Macros are basically lambda functions which you can call in your Cloudformation, using Transformations, to do some processing for you. They can take arguments and also return values.

In our case we are trying to build the bucket policy for the centralized bucket. We need to allow permissions for each account. The user inputs the ids of the accounts and we want to transformed those in the appropriate resource for the bucket policy. If the user doesn’t specify the accounts, the function gets a list of all the ids that are under the organization automatically, using the SDK, and then transform those into the appropriate resource, as following:

"arn:aws:s3:::demo6898798798/AWSLogs/1111111111111/*",
"arn:aws:s3:::demo6898798798/AWSLogs/1111111111111/*" 

2.	 Create a bucket in S3, where you will put the lambda code, which is used to sent logs from S3 to CW. 

3.	Upload a compressed version of the lambda code in that bucket. Use the following name: idex.js.zip

4.	Run the master_stack_for_central_vpc.yaml Cloudformation and fill up the parameters, as guided in console. The only mandatory fields are BucketName, BucketLambdaName and LogGroup.



5.	Start sending flow logs from the permitted accounts, using the correct format. You can do this either through the console or by running the createFLowlogs.js in a lambda, with the appropriate permitions. This code will automatilly list all your vpc’s in the account and create a flow log in each with the appropriate formst. However, to run this you have to upload the latest version of the SDK in a lambda leyers, as the default on does not yet support custom format, otherwise install the packages and run from an application with the relevant permitions.
