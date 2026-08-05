/** @jsxImportSource react */
import { type ReactNode, useMemo, useState } from "react";
import type {
  ConfirmOptions,
  CycleSelectOptions,
  AwaitExternalOptions,
  MenuOptions,
  MultiSelectOptions,
  PasswordInputOptions,
  Screen,
  SelectOptions,
  TextInputOptions,
} from "./types.ts";
import { theme } from "./theme.ts";
import { useGlyphs, useKeyGlyphs } from "./components/Environment.tsx";
import {
  BooleanChoice,
  filterChoices,
  CycleList,
  ExternalWait,
  Menu,
  PromptFrame,
  TextField,
  useListNavigation,
  useSelectedChoices,
  useTerminalInput,
  useCycleNavigation,
} from "./components/Interactive.tsx";
import { Box } from "./components/Layout.tsx";
import { AnsweredPrompt } from "./components/Transcript.tsx";
import { Text } from "./components/Typography.tsx";

const errorMessage = (value: string | Error | undefined) =>
  value instanceof Error ? value.message : value;

/**
 * Escape-to-cancel for standard prompts. Ctrl+C is handled centrally by the
 * screen runner (InkRuntime.run), so screens only wire Escape semantics.
 */
const useCancel = (cancel: () => void) =>
  useTerminalInput((_input, key) => {
    if (key.escape) cancel();
  });

const TextPrompt = ({
  options,
  mask,
  submit,
  cancel,
}: {
  readonly options: TextInputOptions | PasswordInputOptions;
  readonly mask?: boolean;
  readonly submit: (value: string, summary?: ReactNode) => void;
  readonly cancel: () => void;
}) => {
  const glyphs = useGlyphs();
  const keys = useKeyGlyphs();
  const maskGlyph = mask ? glyphs.mask : undefined;
  const [error, setError] = useState<string>();
  useCancel(cancel);
  const complete = (raw: string) => {
    const value =
      raw === "" &&
      "defaultValue" in options &&
      options.defaultValue !== undefined
        ? options.defaultValue
        : raw;
    const problem = errorMessage(options.validate?.(value));
    if (problem !== undefined) setError(problem);
    else
      submit(
        value,
        <AnsweredPrompt
          message={options.message}
          answer={
            maskGlyph === undefined
              ? value || "(empty)"
              : maskGlyph.repeat(Math.min(value.length, 12))
          }
        />,
      );
  };
  return (
    <PromptFrame
      message={options.message}
      error={error}
      keys={[
        [keys.enter, "confirm"],
        [keys.escape, "cancel"],
      ]}
    >
      <TextField
        placeholder={options.placeholder}
        initialValue={
          "initialValue" in options ? options.initialValue : undefined
        }
        mask={maskGlyph}
        onChange={() => setError(undefined)}
        onSubmit={complete}
      />
    </PromptFrame>
  );
};

export const textScreen = (options: TextInputOptions): Screen<string> => ({
  name: "text input",
  render: ({ submit, cancel }) => (
    <TextPrompt options={options} submit={submit} cancel={cancel} />
  ),
});

export const passwordScreen = (
  options: PasswordInputOptions,
): Screen<string> => ({
  name: "password input",
  render: ({ submit, cancel }) => (
    <TextPrompt options={options} mask submit={submit} cancel={cancel} />
  ),
});

const SelectPrompt = <Value,>({
  options,
  submit,
  cancel,
  summary = true,
  header,
  footer,
  escapeLabel = "cancel",
}: {
  readonly options: SelectOptions<Value>;
  readonly submit: (value: Value, summary?: ReactNode) => void;
  readonly cancel: () => void;
  readonly summary?: boolean;
  readonly header?: ReactNode;
  readonly footer?: ReactNode;
  readonly escapeLabel?: string;
}) => {
  const keys = useKeyGlyphs();
  const initialIndex = options.options.findIndex(
    (choice) => choice.value === options.initialValue,
  );
  const firstEnabled = options.options.findIndex((choice) => !choice.disabled);
  const { cursor, setCursor } = useListNavigation(
    options.options.length,
    initialIndex !== -1 && !options.options[initialIndex]?.disabled
      ? initialIndex
      : Math.max(0, firstEnabled),
  );
  useCancel(cancel);
  const moveEnabled = (delta: number) => {
    if (options.options.length === 0) return;
    for (let offset = 1; offset <= options.options.length; offset++) {
      const next =
        (cursor + delta * offset + options.options.length) %
        options.options.length;
      const disabled = options.options[next]?.disabled;
      if (disabled === undefined || disabled === false) {
        setCursor(next);
        return;
      }
    }
  };
  useTerminalInput((_input, key) => {
    if (key.up) moveEnabled(-1);
    else if (key.down) moveEnabled(1);
    else if (key.enter) {
      const choice = options.options[cursor];
      if (choice !== undefined && !choice.disabled) {
        submit(
          choice.value,
          summary ? (
            <AnsweredPrompt message={options.message} answer={choice.label} />
          ) : undefined,
        );
      }
    }
  });
  return (
    <Box flexDirection="column" gap={1}>
      {header}
      <PromptFrame
        message={options.message}
        keys={[
          [keys.upDown, "navigate"],
          [keys.enter, "select"],
          [keys.escape, escapeLabel],
        ]}
      >
        <Menu
          choices={options.options}
          cursor={cursor}
          visibleCount={options.visibleCount}
        />
      </PromptFrame>
      {footer}
    </Box>
  );
};

export const selectScreen = <Value,>(
  options: SelectOptions<Value>,
): Screen<Value> => ({
  name: "selection",
  render: ({ submit, cancel }) => (
    <SelectPrompt options={options} submit={submit} cancel={cancel} />
  ),
});

export const menuScreen = <Value,>(
  options: MenuOptions<Value>,
): Screen<Value> => ({
  name: "menu",
  render: ({ submit, cancel }) => (
    <SelectPrompt
      options={options}
      submit={submit}
      cancel={() =>
        options.back !== undefined ? submit(options.back) : cancel()
      }
      summary={false}
      header={options.header}
      footer={options.footer}
      escapeLabel={options.back !== undefined ? "back" : "exit"}
    />
  ),
});

const MultiSelectPrompt = <Value,>({
  options,
  submit,
  cancel,
}: {
  readonly options: MultiSelectOptions<Value>;
  readonly submit: (value: ReadonlyArray<Value>, summary?: ReactNode) => void;
  readonly cancel: () => void;
}) => {
  const keys = useKeyGlyphs();
  const [query, setQuery] = useState("");
  const filtered = useMemo(
    () =>
      options.searchable === false
        ? options.options.map((choice, index) => ({ choice, index }))
        : filterChoices(options.options, query),
    [options.options, options.searchable, query],
  );
  const { cursor, move, setCursor } = useListNavigation(filtered.length);
  const [selected, setSelected] = useSelectedChoices(
    options.options,
    options.initialValues ?? [],
  );
  const [error, setError] = useState<string>();
  useCancel(cancel);
  useTerminalInput((input, key) => {
    if (key.up) move(-1);
    else if (key.down) move(1);
    else if (input === " ") {
      const original = filtered[cursor]?.index;
      if (original === undefined || options.options[original]?.disabled) return;
      setSelected((current) => {
        const next = new Set(current);
        if (next.has(original)) next.delete(original);
        else next.add(original);
        return next;
      });
      setError(undefined);
    } else if (key.enter) {
      if (options.required && selected.size === 0) {
        setError("Select at least one option.");
        return;
      }
      const values = options.options.flatMap((choice, index) =>
        selected.has(index) ? [choice.value] : [],
      );
      const labels = options.options.flatMap((choice, index) =>
        selected.has(index) ? [choice.label] : [],
      );
      submit(
        values,
        <AnsweredPrompt
          message={options.message}
          answer={labels.length === 0 ? "none" : labels.join(", ")}
        />,
      );
    } else if (options.searchable !== false && key.backspace) {
      setQuery((current) => current.slice(0, -1));
      setCursor(0);
    } else if (
      options.searchable !== false &&
      input.length > 0 &&
      !key.ctrl &&
      !key.meta &&
      !key.tab
    ) {
      setQuery((current) => current + input);
      setCursor(0);
    }
  });
  const visibleChoices = filtered.map(({ choice }) => choice);
  const visibleSelected = new Set(
    filtered.flatMap(({ index }, visibleIndex) =>
      selected.has(index) ? [visibleIndex] : [],
    ),
  );
  return (
    <PromptFrame
      message={options.message}
      error={error}
      keys={[
        [keys.upDown, "navigate"],
        [keys.space, "toggle"],
        ...(options.searchable === false
          ? []
          : ([["type", "filter"]] as const)),
        [keys.enter, "confirm"],
      ]}
    >
      <Box flexDirection="column">
        {options.searchable === false ? null : (
          <Text tone="muted">
            Filter: <Text color={theme.color.info}>{query || "all"}</Text>
          </Text>
        )}
        <Menu
          choices={visibleChoices}
          cursor={cursor}
          selected={visibleSelected}
          visibleCount={options.visibleCount}
          empty="No matching choices."
        />
      </Box>
    </PromptFrame>
  );
};

export const multiSelectScreen = <Value,>(
  options: MultiSelectOptions<Value>,
): Screen<ReadonlyArray<Value>> => ({
  name: "multiple selection",
  render: ({ submit, cancel }) => (
    <MultiSelectPrompt options={options} submit={submit} cancel={cancel} />
  ),
});

const CycleSelectPrompt = <State,>({
  options,
  submit,
  cancel,
}: {
  readonly options: CycleSelectOptions<State>;
  readonly submit: (value: ReadonlyArray<State>, summary?: ReactNode) => void;
  readonly cancel: () => void;
}) => {
  const keys = useKeyGlyphs();
  const navigation = useCycleNavigation(
    options.options.map((choice) => choice.states.length),
  );
  useCancel(cancel);
  useTerminalInput((input, key) => {
    if (key.up) navigation.move(-1);
    else if (key.down) navigation.move(1);
    else if (input === " " || key.right) navigation.cycle(1);
    else if (key.left) navigation.cycle(-1);
    else if (key.enter) {
      const values = options.options.flatMap((choice, index) => {
        const state = choice.states[navigation.indices[index] ?? 0];
        return state === undefined ? [] : [state.value];
      });
      const changed = options.options.filter(
        (choice, index) =>
          (navigation.indices[index] ?? 0) !== 0 && choice.states.length > 0,
      );
      submit(
        values,
        <AnsweredPrompt
          message={options.message}
          answer={
            changed.length === 0
              ? "no changes"
              : changed.map((choice) => choice.label).join(", ")
          }
        />,
      );
    }
  });
  return (
    <PromptFrame
      message={options.message}
      keys={[
        [keys.upDown, "navigate"],
        [`${keys.space}/${keys.leftRight}`, "change"],
        [keys.enter, "confirm"],
      ]}
    >
      <CycleList
        choices={options.options}
        cursor={navigation.cursor}
        indices={navigation.indices}
        visibleCount={options.visibleCount}
      />
    </PromptFrame>
  );
};

export const cycleSelectScreen = <State,>(
  options: CycleSelectOptions<State>,
): Screen<ReadonlyArray<State>> => ({
  name: "cycle selection",
  render: ({ submit, cancel }) => (
    <CycleSelectPrompt options={options} submit={submit} cancel={cancel} />
  ),
});

export const awaitExternalScreen = (
  options: AwaitExternalOptions,
): Screen<string> => ({
  name: "external authorization",
  render: ({ submit, cancel }) => (
    <ExternalWait {...options} onSubmit={submit} onCancel={cancel} />
  ),
});

const ConfirmPrompt = ({
  options,
  submit,
  cancel,
}: {
  readonly options: ConfirmOptions;
  readonly submit: (value: boolean, summary?: ReactNode) => void;
  readonly cancel: () => void;
}) => {
  const keys = useKeyGlyphs();
  const [value, setValue] = useState(options.initialValue ?? true);
  useCancel(cancel);
  const complete = (answer: boolean) =>
    submit(
      answer,
      <AnsweredPrompt
        message={options.message}
        answer={answer ? "yes" : "no"}
      />,
    );
  useTerminalInput((input, key) => {
    if (key.left || key.right || key.tab) setValue((current) => !current);
    else if (key.enter) complete(value);
    else if (input.toLowerCase() === "y") complete(true);
    else if (input.toLowerCase() === "n") complete(false);
  });
  return (
    <PromptFrame
      message={options.message}
      keys={[
        [keys.leftRight, "choose"],
        [keys.enter, "confirm"],
      ]}
    >
      <BooleanChoice value={value} />
    </PromptFrame>
  );
};

export const confirmScreen = (options: ConfirmOptions): Screen<boolean> => ({
  name: "confirmation",
  render: ({ submit, cancel }) => (
    <ConfirmPrompt options={options} submit={submit} cancel={cancel} />
  ),
});
