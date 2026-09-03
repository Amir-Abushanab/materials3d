/**
 * The command-line conventions every script shares: `--flag value` parsing that knows its flags,
 * and a `run` wrapper that turns a failure into a non-zero exit after cleanup.
 */

/**
 * Parse `--name value`, `--name=value`, boolean `--name` and bare positionals.
 *
 * `defaults` declares every flag, and each default's type is the flag's type: a number is parsed
 * and validated, a boolean takes no value, a string is taken verbatim. Declaring booleans is what
 * stops a positional after one from being eaten as its value: `--loop prism` once compared
 * `materials`, because `prism` had become the value of `--loop`. An unknown flag is an error that
 * lists the valid ones, and `--help` is always accepted.
 */
export function parseArgs(argv, defaults = {}) {
  const values = { ...defaults };
  const positionals = [];
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help") {
      help = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    if (!(name in defaults)) {
      const known = Object.keys(defaults)
        .map((key) => `--${key}`)
        .join(", ");
      throw new Error(
        `unknown flag --${name}${known ? `; flags are: ${known}` : ""} (--help for usage)`,
      );
    }
    const kind = typeof defaults[name];
    if (kind === "boolean") {
      values[name] = true;
      continue;
    }
    const raw = eq === -1 ? argv[++i] : arg.slice(eq + 1);
    if (raw === undefined) throw new Error(`--${name} needs a value`);
    if (kind === "number") {
      const number = Number(raw);
      if (!Number.isFinite(number)) throw new Error(`--${name} must be a number, got "${raw}"`);
      values[name] = number;
    } else {
      values[name] = raw;
    }
  }
  return { ...values, positionals, help };
}

/**
 * Run a script's `main`, then whatever cleanup it registered, and exit non-zero on any failure.
 *
 * `main` gets `defer(fn)` for the things it opens (a server, a browser); they close in reverse
 * order whether it returns, throws or reports a failure by returning `false`. Several of these
 * scripts used to finish with exit code 0 no matter what they had found, which for a parity
 * harness is the one result that must never happen.
 */
export async function run(main) {
  const cleanups = [];
  const defer = (fn) => cleanups.push(fn);
  try {
    if ((await main(defer)) === false) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    // A cleanup that fails must not hide the result of the run, so each is reported and skipped.
    for (const fn of cleanups.toReversed()) {
      try {
        await fn();
      } catch (error) {
        console.error(`cleanup failed: ${error instanceof Error ? error.message : error}`);
      }
    }
  }
}
