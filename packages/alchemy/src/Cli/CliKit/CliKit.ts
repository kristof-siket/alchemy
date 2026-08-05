import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type { NonInteractiveTerminal } from "./errors.ts";
import type {
  ConfirmOptions,
  CycleSelectOptions,
  AwaitExternalOptions,
  AlertOptions,
  MessageOptions,
  InteractionError,
  LiveViewHandle,
  LiveViewOptions,
  MenuOptions,
  MultiSelectOptions,
  PasswordInputOptions,
  ProgressHandle,
  ProgressOptions,
  RenderOptions,
  Screen,
  SelectOptions,
  CliKitCapabilities,
  TextInputOptions,
  View,
} from "./types.ts";

export interface CliKitService {
  readonly capabilities: CliKitCapabilities;

  /** Append a completed layout to terminal scrollback/output. */
  readonly print: (view: View) => Effect.Effect<void>;

  /** Render a layout without writing it. Useful for help, logs and snapshots. */
  readonly format: (view: View, options?: RenderOptions) => string;

  /** Effect form of `format`, useful when composing CLI programs. */
  readonly render: (
    view: View,
    options?: RenderOptions,
  ) => Effect.Effect<string>;

  /** Append an arbitrary visual layout. Prefer the semantic methods for logs. */
  readonly display: (view: View) => Effect.Effect<void>;

  /** Backend-safe messages: styled in a TTY and plain text everywhere else. */
  readonly info: (message: string | MessageOptions) => Effect.Effect<void>;
  readonly success: (message: string | MessageOptions) => Effect.Effect<void>;
  readonly warn: (message: string | MessageOptions) => Effect.Effect<void>;
  readonly error: (message: string | MessageOptions) => Effect.Effect<void>;
  readonly alert: (options: AlertOptions) => Effect.Effect<void>;

  readonly text: (
    options: TextInputOptions,
  ) => Effect.Effect<string, InteractionError>;
  readonly password: (
    options: PasswordInputOptions,
  ) => Effect.Effect<string, InteractionError>;
  readonly confirm: (
    options: ConfirmOptions,
  ) => Effect.Effect<boolean, InteractionError>;
  readonly select: <Value>(
    options: SelectOptions<Value>,
  ) => Effect.Effect<Value, InteractionError>;
  readonly multiSelect: <Value>(
    options: MultiSelectOptions<Value>,
  ) => Effect.Effect<ReadonlyArray<Value>, InteractionError>;
  readonly cycleSelect: <State>(
    options: CycleSelectOptions<State>,
  ) => Effect.Effect<ReadonlyArray<State>, InteractionError>;
  readonly awaitExternal: (
    options: AwaitExternalOptions,
  ) => Effect.Effect<string, InteractionError>;

  /**
   * Display an application menu. Each invocation replaces the current app
   * flow, so looping back to a menu clears any prompts shown since the last
   * selection.
   */
  readonly menu: <Value>(
    options: MenuOptions<Value>,
  ) => Effect.Effect<Value, InteractionError>;

  /** Run an arbitrary interactive screen in the service's single live region. */
  readonly run: <Value>(
    screen: Screen<Value>,
  ) => Effect.Effect<Value, InteractionError>;

  /**
   * Keep one renderer alive while an Effect drives menus, screens and prompt
   * flows. The application is cleared and the renderer exits when it settles.
   */
  readonly app: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | NonInteractiveTerminal, R>;

  /** Clear the current application's transcript and live region. */
  readonly clear: Effect.Effect<void>;

  /** Clear completed output while preserving the application's live region. */
  readonly clearTranscript: Effect.Effect<void>;

  /** Add a mutable row to the live region. The handle is idempotent. */
  readonly progress: (
    options: ProgressOptions,
  ) => Effect.Effect<ProgressHandle>;

  /** Mount a mutable arbitrary layout in the service-owned live region. */
  readonly live: (
    view: View,
    options?: LiveViewOptions,
  ) => Effect.Effect<LiveViewHandle>;

  /** Run work behind a progress row and collapse it to a final status line. */
  readonly task: <A, E, R>(
    options: ProgressOptions,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;

  /** Attribute output produced by body to a nested visual section. */
  readonly section: <A, E, R>(
    title: string,
    body: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
}

const unavailable = () => Effect.die("CliKit service was not provided");

const unavailableService: CliKitService = {
  capabilities: {
    input: false,
    columns: 80,
    rows: 24,
    colors: false,
    unicode: false,
  },
  print: unavailable,
  format: () => {
    throw new Error("CliKit service was not provided");
  },
  render: unavailable,
  display: unavailable,
  info: unavailable,
  success: unavailable,
  warn: unavailable,
  error: unavailable,
  alert: unavailable,
  text: unavailable,
  password: unavailable,
  confirm: unavailable,
  select: unavailable,
  multiSelect: unavailable,
  cycleSelect: unavailable,
  awaitExternal: unavailable,
  menu: unavailable,
  run: unavailable,
  app: unavailable,
  clear: unavailable(),
  clearTranscript: unavailable(),
  progress: unavailable,
  live: unavailable,
  task: unavailable,
  section: unavailable,
};

/** The sole injected owner of terminal rendering and input for a CLI process. */
export const CliKit = Context.Reference<CliKitService>("Alchemy::CliKit", {
  defaultValue: () => unavailableService,
});
