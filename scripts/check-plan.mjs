import {readFileSync} from 'node:fs';
export function checkPlan(plan){
 if(!plan||typeof plan!=='object'||!Array.isArray(plan.resource_changes))throw Error('Invalid Terraform plan');
 for(const resource of plan.resource_changes){if(resource.change.actions.some(x=>x==='delete'))throw Error(`Destructive change rejected: ${resource.address}`);if(!['cloudflare_d1_database','cloudflare_r2_bucket','cloudflare_queue'].includes(resource.type))throw Error(`Unowned resource rejected: ${resource.address}`);}
 return true;
}
if(process.argv[1]?.endsWith('check-plan.mjs')){checkPlan(JSON.parse(readFileSync(process.argv[2],'utf8')));console.log('Plan contains no destructive or unowned resource changes.');}
