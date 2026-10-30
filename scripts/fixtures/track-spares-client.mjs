/** Preserve the real client's event/release lifecycle while observing SQL. */
export function trackSpareClient(client,observe){return new Proxy(client,{get(target,key){if(key==='query')return(...args)=>{const value=target.query(...args);observe(args[0],value);return value;};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});}
