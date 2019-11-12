const AWS = require("aws-sdk");
const ec2 = new AWS.EC2();
exports.handler = async (event) => {
    const vpcData = await ec2.describeVpcs().promise();
    console.log("-------");
    console.log(vpcData);
    console.log("-------");
    
    const vpcIds = vpcData.Vpcs.map(v => v.VpcId);
    console.log(vpcIds);
    console.log("-------");
    const params = {
        ResourceIds: vpcIds,
        ResourceType:'VPC',
        TrafficType: 'ALL',
        LogDestination: 'arn:aws:s3:::demo878987890',
        LogDestinationType: 's3',
        LogFormat: '${account-id} ${action} ${bytes} ${dstaddr} ${dstport} ${end} ${instance-id} ${interface-id} ${log-status} ${packets} ${pkt-dstaddr} ${pkt-srcaddr} ${protocol} ${srcaddr} ${srcport} ${start} ${subnet-id} ${tcp-flags} ${type} ${version} ${vpc-id}'
    };       
    const result = await ec2.createFlowLogs(params).promise();
    console.log(result);
    console.log("-------");
};  