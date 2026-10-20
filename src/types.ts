export interface Device { id:string; code:string; name:string; line:string; status:string; oee:number; mtbf:number; mttr:number; updatedAt:string }
export interface AiReview { conclusion:string; confidence:number; evidence:string[]; recommendedAction:string; risk:string; status:string }
export interface Alarm { id:string; deviceId:string; title:string; severity:string; state:string; assignee?:string; aiReview?:AiReview; updatedAt:string }
export interface Overview { tenant:{name:string;plan:string}; metrics:{deviceCount:number;running:number;activeAlarms:number;pendingApprovals:number;oee:number;mtbf:number;mttr:number}; devices:Device[]; alarms:Alarm[] }
export interface Audit { eventId:string; objectType:string; objectId:string; action:string;actorType:string;actorId:string;businessTime:string;hash:string;metadata:Record<string,unknown> }
