import type { RegisteredTool } from "./types.js";

/** Activity metadata belongs to model calls and history; delegates receive operational arguments. */
function operationalInput(input: Record<string, unknown>): Record<string, unknown> {
  const { purpose: _purpose, targets: _targets, ...operational } = input;
  return operational;
}

/** Decorate at the Runtime boundary so host-added tools share the same model contract. */
export function withToolActivity(tool: RegisteredTool): RegisteredTool {
  const { parameters } = tool.definition;
  for (const field of ["purpose", "targets"]) {
    if (Object.hasOwn(parameters.properties, field) || parameters.required.includes(field)) {
      throw new Error(`Tool ${tool.definition.name} declares reserved activity parameter "${field}".`);
    }
  }

  return {
    ...tool,
    definition: {
      ...tool.definition,
      parameters: {
        ...parameters,
        properties: {
          ...parameters.properties,
          purpose: {
            type: "string",
            description: "Short action intent in the current user's language, describing the goal rather than shell commands, output, or private reasoning.",
          },
          targets: {
            type: "array",
            description: "Specific file paths, search queries, or entity labels affected by this call. Use an empty array when there is no specific target; exclude shell commands and output.",
            items: { type: "string", description: "A file path, search query, or entity label" },
          },
        },
        // Executors remain compatible with legacy calls; targets may be absent.
        required: [...parameters.required, "purpose"],
      },
    },
    execute: (input, context) => tool.execute(operationalInput(input), context),
    ...(tool.prepare ? {
      prepare: (input, context) => tool.prepare!(operationalInput(input), context),
    } : {}),
    recovery: {
      ...tool.recovery,
      ...(tool.recovery.reconcile ? {
        reconcile: (input, checkpoint, context) => tool.recovery.reconcile!(operationalInput(input), checkpoint, context),
      } : {}),
    },
  };
}
