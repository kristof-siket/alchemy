/** @jsxImportSource react */
import { useState, type JSX } from "react";
import {
  BooleanChoice,
  Box,
  KeyBar,
  Text,
  useGlyphs,
  useKeyGlyphs,
  useTerminalInput,
} from "../CliKit/components.ts";
import { Screen, theme, type ScreenController } from "../CliKit/index.ts";
import type { Plan as AlchemyPlan } from "../../Plan.ts";
import { Plan } from "./Plan.tsx";

export interface ApprovePlanProps {
  plan: AlchemyPlan;
  controller: ScreenController<boolean>;
}

/**
 * Plan approval prompt: the plan tree followed by the same Yes/No choice and
 * key bar that `CliKit.confirm` renders. Escape cancels (treated as "no" by
 * the caller); Ctrl+C is handled centrally by the screen runner.
 */
export function ApprovePlan(props: ApprovePlanProps): JSX.Element {
  const { plan, controller } = props;
  const [approved, setApproved] = useState(true);
  const glyphs = useGlyphs();
  const keys = useKeyGlyphs();

  const complete = (answer: boolean) =>
    controller.submit(
      answer,
      <Text color={answer ? theme.color.success : theme.color.danger}>
        {answer ? glyphs.success : glyphs.error} Proceed?{" "}
        {answer ? "Yes" : "No"}
      </Text>,
    );

  useTerminalInput((input, key) => {
    if (key.left || key.right || key.tab || key.up || key.down)
      setApproved((current) => !current);
    else if (key.enter) complete(approved);
    else if (key.escape) controller.cancel();
    else if (key.ctrl || key.meta) return;
    else if (input.toLowerCase() === "y") complete(true);
    else if (input.toLowerCase() === "n") complete(false);
  });

  return (
    <Box flexDirection="column" gap={1} marginTop={1}>
      <Plan plan={plan} />
      <Box flexDirection="column" gap={1}>
        <Text bold>Proceed?</Text>
        <BooleanChoice value={approved} />
        <KeyBar
          keys={[
            [keys.leftRight, "choose"],
            [keys.enter, "confirm"],
            [keys.escape, "cancel"],
          ]}
        />
      </Box>
    </Box>
  );
}

export const approvePlanScreen = (plan: AlchemyPlan) =>
  Screen.make<boolean>("plan approval", (controller) => (
    <ApprovePlan plan={plan} controller={controller} />
  ));
