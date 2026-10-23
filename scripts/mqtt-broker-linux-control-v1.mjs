/** The owned broker must have installed SIGINT before a creation-stage stop may signal it. */
export function mqttBrokerLinuxControlV1(status){
  if(typeof status!=='string'||status.length>131072)throw Error('MQTT_BROKER_SIGNAL_STATUS_INVALID');
  const rows=status.split('\n').filter(row=>row.startsWith('SigCgt:'));
  if(rows.length!==1)throw Error('MQTT_BROKER_SIGNAL_STATUS_INVALID');
  const match=/^SigCgt:\s+([a-fA-F0-9]{1,16})\s*$/.exec(rows[0]);
  if(!match)throw Error('MQTT_BROKER_SIGNAL_STATUS_INVALID');
  const mask=BigInt('0x'+match[1]),sigintCaught=(mask&2n)!==0n,sigtermCaught=(mask&(1n<<14n))!==0n;
  return {sigintCaught,sigtermCaught,ready:sigintCaught};
}
