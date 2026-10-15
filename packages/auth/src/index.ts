// Barrel for client-only usage. Server-only code lives in ./server and must be
// imported explicitly to keep it out of the Next.js browser bundle.
export * from './client.ts';
// `./email` is server-only but re-exported here so api code can `import
// { sendEmail } from '@reomi/auth'` without knowing the file layout.
// Safe in the browser bundle because it has no Node/Bun deps — pure fetch.
export { sendEmail, getEmailProvider, type EmailProvider, type SendEmailInput } from './email.ts';
