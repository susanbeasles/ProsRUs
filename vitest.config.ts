import {defineConfig} from 'vitest/config';
export default defineConfig({test:{include:['tests/**/*.test.{ts,tsx}'],environmentOptions:{happyDOM:{url:'https://local.invalid/owner/job-stack'}}}});
