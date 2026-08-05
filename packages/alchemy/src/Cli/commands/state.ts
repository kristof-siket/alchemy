import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Argument from "effect/unstable/cli/Argument";
import { Command, Flag } from "effect/unstable/cli";

import { AuthProviders } from "../../Auth/AuthProvider.ts";
import { withProfileOverride } from "../../Auth/Profile.ts";
import * as CliKit from "../../Cli/CliKit/index.ts";
import { Stage } from "../../Stage.ts";
import * as State from "../../State/index.ts";
import { encodeState } from "../../State/StateEncoding.ts";
import { loadConfigProvider } from "../../Util/ConfigProvider.ts";
import { fileLogger } from "../../Util/FileLogger.ts";

import {
  config,
  envFile,
  exitDeclined,
  failWithHelp,
  importStack,
  instrumentCommand,
  profile,
  UserInputError,
  yes,
} from "./_shared.ts";

const backend = Flag.choice("backend", ["configured", "local"] as const).pipe(
  Flag.withDescription("State backend (default: configured)"),
  Flag.withDefault("configured" as const),
);

const stackArgument = Argument.string("stack").pipe(
  Argument.withDescription("Stack name"),
  Argument.optional,
);

const stageArgument = Argument.string("stage").pipe(
  Argument.withDescription("Stage name"),
  Argument.optional,
);

const requiredStackArgument = Argument.string("stack").pipe(
  Argument.withDescription("Stack name"),
);

const requiredStageArgument = Argument.string("stage").pipe(
  Argument.withDescription("Stage name"),
);

const fqnArgument = Argument.string("fqn").pipe(
  Argument.withDescription("Fully-qualified resource name"),
);

type StateArgs = {
  readonly main: string;
  readonly envFile: Option.Option<string>;
  readonly profile: string | undefined;
  readonly backend: "configured" | "local";
};

const withStateService = <A, E>(
  args: StateArgs,
  body: (state: State.StateService) => Effect.Effect<A, E, never>,
) =>
  Effect.gen(function* () {
    if (args.backend === "local") {
      return yield* Effect.gen(function* () {
        return yield* body(yield* yield* State.State);
      }).pipe(Effect.provide(State.localState()));
    }

    const stackEffect = yield* importStack(args.main);
    const services = Layer.mergeAll(
      Layer.succeed(AuthProviders, {}),
      ConfigProvider.layer(
        withProfileOverride(
          yield* loadConfigProvider(args.envFile),
          args.profile,
        ),
      ),
      Logger.layer([fileLogger("out")], { mergeWithExisting: true }),
      Layer.succeed(Stage, "placeholder"),
    );

    return yield* Effect.gen(function* () {
      const stack = yield* stackEffect;
      return yield* Effect.gen(function* () {
        return yield* body(yield* yield* State.State);
      }).pipe(Effect.provide(stack.services));
    }).pipe(Effect.provide(services));
  });

const writeList = (values: ReadonlyArray<string>, emptyMessage: string) =>
  Effect.gen(function* () {
    const sorted = [...values].sort();
    if (sorted.length === 0) {
      yield* (yield* CliKit.CliKit).info(emptyMessage);
    } else {
      yield* Console.log(sorted.join("\n"));
    }
  });

const listCommand = Command.make(
  "list",
  {
    stack: stackArgument,
    stage: stageArgument,
    main: config,
    envFile,
    profile,
    backend,
  },
  instrumentCommand("state.list")(
    Effect.fn(function* ({ stack, stage, ...rest }) {
      const stackName = Option.getOrUndefined(stack);
      const stageName = Option.getOrUndefined(stage);
      if (stageName !== undefined && stackName === undefined) {
        return yield* Effect.fail(
          new UserInputError({ message: "stage requires a stack" }),
        );
      }
      yield* withStateService(rest, (state) =>
        stackName === undefined
          ? state
              .listStacks()
              .pipe(Effect.flatMap((items) => writeList(items, "no stacks")))
          : stageName === undefined
            ? state
                .listStages(stackName)
                .pipe(
                  Effect.flatMap((items) =>
                    writeList(items, `no stages in ${stackName}`),
                  ),
                )
            : state
                .list({ stack: stackName, stage: stageName })
                .pipe(
                  Effect.flatMap((items) =>
                    writeList(
                      items,
                      `no resources in ${stackName}/${stageName}`,
                    ),
                  ),
                ),
      );
    }),
  ),
).pipe(
  Command.withDescription(
    "List stacks, stages in a stack, or resources in a stack and stage",
  ),
);

const getCommand = Command.make(
  "get",
  {
    stack: requiredStackArgument,
    stage: requiredStageArgument,
    fqn: fqnArgument,
    main: config,
    envFile,
    profile,
    backend,
  },
  instrumentCommand("state.get")(
    Effect.fn(function* ({ stack, stage, fqn, ...rest }) {
      yield* withStateService(rest, (state) =>
        Effect.gen(function* () {
          const value = yield* state.get({ stack, stage, fqn });
          if (value === undefined) {
            yield* (yield* CliKit.CliKit).warn(
              `not found: ${stack}/${stage}/${fqn}`,
            );
            return;
          }
          yield* Console.log(JSON.stringify(encodeState(value), null, 2));
        }),
      );
    }),
  ),
).pipe(Command.withDescription("Print the stored state of one resource"));

const exportCommand = Command.make(
  "export",
  {
    stack: stackArgument,
    stage: stageArgument,
    main: config,
    envFile,
    profile,
    backend,
  },
  instrumentCommand("state.export")(
    Effect.fn(function* ({ stack, stage, ...rest }) {
      const stackName = Option.getOrUndefined(stack);
      const stageName = Option.getOrUndefined(stage);
      if (stageName !== undefined && stackName === undefined) {
        return yield* Effect.fail(
          new UserInputError({ message: "stage requires a stack" }),
        );
      }
      yield* withStateService(rest, (state) =>
        Effect.gen(function* () {
          const exported = yield* State.exportState(state, {
            stack: stackName,
            stage: stageName,
          });
          yield* Console.log(
            JSON.stringify(
              {
                resources: exported.resources.map((resource) => ({
                  ...resource,
                  state: encodeState(resource.state),
                })),
              },
              null,
              2,
            ),
          );
        }),
      );
    }),
  ),
).pipe(Command.withDescription("Export state as JSON, optionally by scope"));

const clearCommand = Command.make(
  "clear",
  {
    stack: stackArgument,
    stage: stageArgument,
    main: config,
    envFile,
    profile,
    backend,
    yes,
  },
  instrumentCommand("state.clear")(
    Effect.fn(function* ({ stack, stage, yes: approved, ...rest }) {
      const stackName = Option.getOrUndefined(stack);
      const stageName = Option.getOrUndefined(stage);
      if (stageName !== undefined && stackName === undefined) {
        return yield* Effect.fail(
          new UserInputError({ message: "stage requires a stack" }),
        );
      }

      yield* withStateService(rest, (state) =>
        Effect.gen(function* () {
          const targets: ReadonlyArray<{ stack: string; stage?: string }> =
            stackName === undefined
              ? [...(yield* state.listStacks())]
                  .sort()
                  .map((stack) => ({ stack }))
              : [{ stack: stackName, stage: stageName }];

          if (targets.length === 0) {
            yield* (yield* CliKit.CliKit).info("nothing to clear");
            return;
          }

          const scope =
            stackName === undefined
              ? `all ${targets.length} stacks`
              : stageName === undefined
                ? `all state for stack '${stackName}'`
                : `state for '${stackName}/${stageName}'`;
          if (!approved) {
            const confirmed = yield* (yield* CliKit.CliKit).confirm({
              message: `Delete ${scope}? Cloud resources are not deleted.`,
              initialValue: false,
            });
            if (!confirmed) return yield* exitDeclined;
          }

          yield* Effect.forEach(
            targets,
            (target) => state.deleteStack(target),
            { concurrency: 32 },
          );
          yield* (yield* CliKit.CliKit).success(`cleared ${scope}`);
        }),
      );
    }),
  ),
).pipe(Command.withDescription("Delete state records without cloud resources"));

const stateExplorer = (args: StateArgs) =>
  withStateService(args, (state) =>
    Effect.gen(function* () {
      const cli = yield* CliKit.CliKit;
      yield* cli.app(
        Effect.gen(function* () {
          const stacks = [...(yield* state.listStacks())].sort();
          if (stacks.length === 0) {
            yield* cli.info("no stacks");
            return;
          }
          while (true) {
            const stack = yield* cli.menu<string | undefined>({
              message: "Select a stack",
              back: undefined,
              options: stacks.map((value) => ({ value, label: value })),
            });
            if (stack === undefined) return;

            while (true) {
              const stages = [...(yield* state.listStages(stack))].sort();
              if (stages.length === 0) {
                yield* cli.info(`no stages in ${stack}`);
                break;
              }
              const stage = yield* cli.menu<string | undefined>({
                message: stack,
                back: undefined,
                options: stages.map((value) => ({ value, label: value })),
              });
              if (stage === undefined) break;

              while (true) {
                const fqns = [...(yield* state.list({ stack, stage }))].sort();
                if (fqns.length === 0) {
                  yield* cli.info(`no resources in ${stack}/${stage}`);
                  break;
                }
                const fqn = yield* cli.menu<string | undefined>({
                  message: `${stack}/${stage}`,
                  back: undefined,
                  options: fqns.map((value) => ({ value, label: value })),
                });
                if (fqn === undefined) break;
                const value = yield* state.get({ stack, stage, fqn });
                yield* cli.alert({
                  title: fqn,
                  message:
                    value === undefined
                      ? "State record was not found"
                      : JSON.stringify(encodeState(value), null, 2),
                });
              }
            }
          }
        }),
      );
    }),
  );

export const stateCommand = Command.make(
  "state",
  { main: config, envFile, profile, backend },
  instrumentCommand("state")(
    Effect.fn(function* (args) {
      if (!(yield* CliKit.CliKit).capabilities.input) {
        return yield* failWithHelp(["alchemy", "state"]);
      }
      yield* stateExplorer(args);
    }),
  ),
).pipe(
  Command.withDescription("Inspect and manage deployment state"),
  Command.withSubcommands([
    listCommand,
    getCommand,
    exportCommand,
    clearCommand,
  ]),
);
