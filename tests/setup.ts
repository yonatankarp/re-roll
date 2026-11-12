import { fc } from "@fast-check/vitest";

// Fixed seeds, so a failing property fails the same way on every run and machine.
fc.configureGlobal({ seed: 20261112 });
