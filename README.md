# CentralizingVPCFlowLogsInCW

## How to run:
Clone this repo

Make sure you have Organizations set up/ or have multiple accounts ready, so you can run the following steps.

On the master account, or just the account you are centralizing the logs in:

1. Run the macro.yaml in CloudFormation and wait until completed.


Macros are basically lambda functions which you can call in your Cloudformation, using Transformations, to do some processing for you. They can take arguments and also return values.

In our case we are trying to build the bucket policy for the centralized bucket. We need to allow permissions for each account. The user inputs the ids of the accounts and we want to transformed those in the appropriate resource for the bucket policy. If the user doesn’t specify the accounts, the function gets a list of all the ids that are under the organization automatically, using the SDK, and then transform those into the appropriate resource, as following:


> "arn:aws:s3:::demo6898798798/AWSLogs/753390936611/*",  
> "arn:aws:s3:::demo6898798798/AWSLogs/677731379415/*" 


2. Create a bucket in S3, where you will put the lambda code, which is used to sent logs from S3 to CW. 


3. Upload a compressed version of the lambda code (index.js) in that bucket. Use the following name: idex.js.zip


4. Run the master_stack_for_central_vpc.yaml Cloudformation and fill up the parameters, as guided in console. The only mandatory fields are BucketName, BucketLambdaName and LogGroup.

5. Once the Cloudformation has successfully completed, copy the arn of your bucket where logs will be sent to. Save that somewhere as you will need it for sending the flow logs.


On all accounts:

6. Start sending flow logs from the permitted accounts, using the correct format (the format you allowed in the cloudFormation templates, the default is :

>  ${account-id} ${action} ${bytes} ${dstaddr} ${dstport} ${end} ${instance-id} ${interface-id} ${log-status} ${packets} ${pkt-dstaddr} ${pkt-srcaddr} ${protocol} ${srcaddr} ${srcport} ${start} ${subnet-id} ${tcp-flags}${type} ${version} ${vpc-id}).

 You can do this either through the console or by running the createFLowlogs.js (changing the bucket name and format to your desired ones) in a lambda, with the appropriate permissions. This code will automatically list all your vpc’s in the account and create a flow log in each with the appropriate format. However, to run this you have to upload the latest version of the SDK in a lambda layers, as the default on does not yet support custom format, otherwise install the packages and run from an application with the relevant permissions.

7. Optionally you can schedule this code to periodically check if any of those VPC’s do not have flow logs in the central bucket, and create them for you.
