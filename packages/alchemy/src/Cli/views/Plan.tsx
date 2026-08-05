/** @jsxImportSource react */
import { useMemo, type JSX } from "react";
import { Box, Row, TaskRow, Text } from "../CliKit/components.ts";
import type {
  Plan as AlchemyPlan,
  CRUD,
  ActionApply,
  ActionDelete,
} from "../../Plan.ts";
import { buildNamespaceTree, flattenTree } from "../NamespaceTree.ts";
import { formatModeNote } from "../ModeTag.ts";
import { theme } from "../CliKit/index.ts";
import { NamespaceRow, namespaceStyle } from "./PlanRow.tsx";

export interface PlanProps {
  plan: AlchemyPlan;
}

export function Plan({ plan }: PlanProps): JSX.Element {
  const { items, taskItems, flatItems } = useMemo(() => {
    const items = [
      ...Object.values(plan.resources),
      ...Object.values(plan.deletions),
    ] as CRUD[];
    const taskItems = [
      ...Object.values(plan.actions ?? {}),
      ...Object.values(plan.actionDeletions ?? {}),
    ].filter((task): task is ActionApply | ActionDelete => task !== undefined);
    return {
      items,
      taskItems,
      flatItems: flattenTree(buildNamespaceTree(items, taskItems)),
    };
  }, [plan]);

  if (items.length === 0 && taskItems.length === 0) {
    return <Text tone="muted">No changes planned</Text>;
  }

  const counts = { create: 0, update: 0, delete: 0, noop: 0, replace: 0 };
  for (const item of items) counts[item.action]++;
  const taskCounts = { run: 0, noop: 0, delete: 0 };
  for (const item of taskItems) taskCounts[item.action]++;

  const actions = (["create", "update", "delete", "replace"] as const).filter(
    (action) => counts[action] > 0,
  );
  const summary = [
    ...actions.map((action) => ({
      key: action,
      label: `${counts[action]} to ${action}`,
      color: namespaceStyle(action).color,
    })),
    ...(taskCounts.run > 0
      ? [
          {
            key: "run",
            label: `${taskCounts.run} to run`,
            color: theme.color.info,
          },
        ]
      : []),
    ...(taskCounts.delete > 0
      ? [
          {
            key: "drop",
            label: `${taskCounts.delete} to drop`,
            color: theme.color.info,
          },
        ]
      : []),
  ];

  return (
    <Box flexDirection="column" gap={1}>
      <Box>
        <Text underline>Plan</Text>
        <Text>: </Text>
        {summary.map((item, index) => (
          <Box key={item.key}>
            {index === 0 ? null : <Text> | </Text>}
            <Text color={item.color}>{item.label}</Text>
          </Box>
        ))}
      </Box>
      <Box flexDirection="column">
        {flatItems.map((item) => {
          const style = namespaceStyle(item.action);
          const key = item.path.join("/");

          if (item.type === "namespace") {
            return (
              <NamespaceRow
                key={key}
                id={item.id}
                depth={item.depth}
                action={item.action}
              />
            );
          }

          if (item.type === "binding") {
            return (
              <Row key={key} gap={1} paddingLeft={item.depth * 2}>
                <Text color={style.color}>{style.icon}</Text>
                <Text color={theme.color.info}>{item.bindingSid}</Text>
              </Row>
            );
          }

          if (item.type === "action") {
            return (
              <TaskRow
                key={key}
                icon={style.icon}
                iconColor={style.color}
                label={item.id}
                detail={`(${item.actionType})`}
                depth={item.depth}
              >
                <Text color={theme.color.info}>[action]</Text>
              </TaskRow>
            );
          }

          // Resource item
          const modeNote = formatModeNote({
            mode: item.providerMode,
            priorMode: item.fromProviderMode,
            defaultMode: plan.defaultMode,
          });
          return (
            <TaskRow
              key={key}
              icon={style.icon}
              iconColor={style.color}
              label={item.id}
              detail={`(${item.resourceType})`}
              depth={item.depth}
            >
              {modeNote && <Text tone="muted">({modeNote})</Text>}
              {item.bindingCount !== undefined && item.bindingCount > 0 && (
                <Text color={theme.color.info}>
                  ({item.bindingCount} bindings)
                </Text>
              )}
            </TaskRow>
          );
        })}
      </Box>
    </Box>
  );
}
