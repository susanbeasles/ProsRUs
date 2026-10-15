// Retired broad-profile integration. The actual Control owns canonical shared authorization.
export const jobStackDescriptor={id:'job-stack',title:'Job Stack',description:'Personal recruiting observations.',binding:'JOB_STACK'};
export const jobStackScopes=[];
export async function serveJobStackOwner(){throw Error('operation-unavailable');}
export async function serveJobStackMcp(){throw Error('operation-unavailable');}
