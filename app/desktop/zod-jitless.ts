import { config } from "zod";

// The CSP has no 'unsafe-eval', so zod parses without probing for new Function, which the CSP reports.
config({ jitless: true });
