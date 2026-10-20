export class FieldChannelError extends Error {
 readonly code:string;
 constructor(code:string){const safe=typeof code==='string'&&/^FIELD_[A-Z0-9_]{1,96}$/.test(code)?code:'FIELD_OPERATION_FAILED';super(safe);this.name='FieldChannelError';this.code=safe;}
}
export function fieldFailure(code:string):never {throw new FieldChannelError(code);}
