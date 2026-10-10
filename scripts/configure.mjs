import {readFileSync,writeFileSync} from 'node:fs';
const [outputFile,ownerId,googleClientId]=process.argv.slice(2);
if(!outputFile||!ownerId||ownerId==='UNCONFIGURED')throw Error('Usage: node scripts/configure.mjs terraform-output.json owner-id [google-client-id]');
const outputs=JSON.parse(readFileSync(outputFile,'utf8'));const value=name=>outputs[name]?.value;
const environment=value('environment');if(!['staging','production'].includes(environment))throw Error('Invalid environment');
const config=JSON.parse(readFileSync('wrangler.jsonc','utf8'));config.name=`job-stack-${environment}`;config.account_id=value('account_id');config.vars.OWNER_ID=ownerId;config.vars.GOOGLE_CLIENT_ID=googleClientId??'';config.d1_databases[0].database_id=value('database_id');config.d1_databases[0].database_name=config.name;config.r2_buckets[0].bucket_name=value('bucket_name');config.queues.producers[0].queue=value('queue_name');config.queues.consumers[0].queue=value('queue_name');config.queues.consumers[0].dead_letter_queue=`${config.name}-dlq`;
if(!/^[a-f0-9-]{36}$/.test(config.d1_databases[0].database_id)||!config.account_id)throw Error('Invalid Terraform outputs');
writeFileSync(`wrangler.${environment}.json`,JSON.stringify(config,null,2)+'\n');console.log(`Wrote wrangler.${environment}.json; commit this non-secret configuration before deployment.`);
