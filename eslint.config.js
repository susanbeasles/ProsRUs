import tseslint from 'typescript-eslint';
export default tseslint.config({ignores:["src/bindings.d.ts"]},...tseslint.configs.recommended, {rules:{'@typescript-eslint/no-explicit-any':'error','@typescript-eslint/no-non-null-assertion':'error'}});
