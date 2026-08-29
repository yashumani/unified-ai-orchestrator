import {
  DashboardExpressionSchema,
  type DashboardManifest
} from "@unified-ai/contracts/dashboard-builder";
import {
  useCallback,
  useEffect,
  useState,
  type ChangeEvent
} from "react";

type DashboardParameter = DashboardManifest["parameters"][number];
type DashboardComponent = DashboardManifest["components"][number];
type DashboardInteraction = DashboardManifest["interactions"][number];
type PortableExpression = Extract<
  DashboardManifest["calculations"][number],
  { kind: "portable" }
>["expression"];

function PortableExpressionInput({
  calculationId,
  expression,
  disabled,
  onBufferedChange,
  onChange,
  onValidityChange
}: {
  calculationId: string;
  expression: PortableExpression;
  disabled: boolean;
  onBufferedChange: () => void;
  onChange: (expression: PortableExpression) => void;
  onValidityChange: (valid: boolean) => void;
}) {
  const [text, setText] = useState(() => JSON.stringify(expression, null, 2));
  const [error, setError] = useState<string | null>(null);
  const errorId = `portable-expression-${calculationId}-error`;

  return (
    <>
      <textarea
        rows={5}
        disabled={disabled}
        value={text}
        aria-invalid={error !== null}
        {...(error === null ? {} : { "aria-describedby": errorId })}
        onChange={(event) => {
          const nextText = event.target.value;
          setText(nextText);
          onBufferedChange();
          try {
            const parsed = DashboardExpressionSchema.parse(
              JSON.parse(nextText) as unknown
            );
            setError(null);
            onValidityChange(true);
            onChange(parsed);
          } catch {
            setError("Enter a valid allowlisted portable expression tree.");
            onValidityChange(false);
          }
        }}
      />
      {error === null ? null : (
        <small className="dashboard-field-error" id={errorId} role="alert">
          {error}
        </small>
      )}
    </>
  );
}

function uniqueId(prefix: string, existing: readonly string[]): string {
  let index = existing.length + 1;
  while (existing.includes(`${prefix}-${String(index)}`)) {
    index += 1;
  }
  return `${prefix}-${String(index)}`;
}

function numberValue(event: ChangeEvent<HTMLInputElement>, fallback = 0): number {
  const value = Number(event.target.value);
  return Number.isFinite(value) ? value : fallback;
}

function parameterForType(
  parameter: DashboardParameter,
  type: DashboardParameter["type"]
): DashboardParameter {
  const base = {
    parameterId: parameter.parameterId,
    label: parameter.label,
    affects: parameter.affects
  };
  switch (type) {
    case "string":
      return { ...base, type, defaultValue: "" };
    case "number":
      return { ...base, type, defaultValue: 0, minimum: null, maximum: null };
    case "boolean":
      return { ...base, type, defaultValue: false };
    case "date":
      return {
        ...base,
        type,
        defaultValue: new Date().toISOString().slice(0, 10),
        minimum: null,
        maximum: null
      };
    case "enum":
      return { ...base, type, defaultValue: "Option", choices: ["Option"] };
  }
}

function componentForType(
  component: Pick<DashboardComponent, "componentId" | "title" | "adapter" | "emptyState">,
  type: DashboardComponent["type"],
  manifest: DashboardManifest
): DashboardComponent {
  const base = {
    componentId: component.componentId,
    title: component.title,
    adapter: component.adapter,
    emptyState: component.emptyState
  };
  const calculationId = manifest.calculations[0]?.calculationId ?? "calculation-1";
  const bindingId = manifest.bindings[0]?.bindingId ?? "binding-1";
  switch (type) {
    case "kpi":
      return { ...base, type, calculationId, format: null };
    case "data-table":
      return {
        ...base,
        type,
        columns: [
          {
            columnId: `${component.componentId}-column-1`,
            source: { kind: "binding", id: bindingId },
            header: "Column",
            alignment: "start",
            width: 160,
            sort: "none",
            totalBehavior: "none"
          }
        ],
        pageSize: 25,
        selection: "none"
      };
    case "bar-chart":
    case "line-chart":
      return {
        ...base,
        type,
        dimensionBindingId: bindingId,
        calculationIds: [calculationId],
        sort: "dimension-ascending"
      };
    case "filter":
      return { ...base, type, bindingId, multiSelect: false };
    case "text":
      return { ...base, type, text: "Add plain-text dashboard guidance." };
  }
}

function interactionForType(
  interactionId: string,
  type: DashboardInteraction["type"],
  manifest: DashboardManifest
): DashboardInteraction {
  const fallbackComponentId = manifest.components[0]?.componentId ?? "component-1";
  const chartComponentId =
    manifest.components.find(
      (component) =>
        component.type === "bar-chart" || component.type === "line-chart"
    )?.componentId ?? fallbackComponentId;
  const tableComponentId =
    manifest.components.find((component) => component.type === "data-table")
      ?.componentId ?? fallbackComponentId;
  const filterComponentId =
    manifest.components.find((component) => component.type === "filter")
      ?.componentId ?? fallbackComponentId;
  const targetComponentId = (sourceComponentId: string) =>
    manifest.components.find(
      (component) => component.componentId !== sourceComponentId
    )?.componentId ?? sourceComponentId;
  const targetBindingId = manifest.bindings[0]?.bindingId ?? "binding-1";
  switch (type) {
    case "set-filter":
      return {
        interactionId,
        type,
        sourceComponentId: chartComponentId,
        targetBindingId
      };
    case "clear-filter":
      return {
        interactionId,
        type,
        sourceComponentId: filterComponentId,
        targetBindingId
      };
    case "select-row":
      return {
        interactionId,
        type,
        sourceComponentId: tableComponentId,
        targetComponentId: targetComponentId(tableComponentId)
      };
    case "navigate-section":
      return {
        interactionId,
        type,
        sourceComponentId: fallbackComponentId,
        targetComponentId: targetComponentId(fallbackComponentId)
      };
    case "select-chart-value":
      return {
        interactionId,
        type,
        sourceComponentId: chartComponentId,
        targetComponentId: targetComponentId(chartComponentId),
        targetBindingId
      };
  }
}

export function DashboardManifestEditor({
  manifest,
  disabled,
  onBufferedChange,
  onChange,
  onValidityChange
}: {
  manifest: DashboardManifest;
  disabled: boolean;
  onBufferedChange: () => void;
  onChange: (manifest: DashboardManifest) => void;
  onValidityChange: (valid: boolean) => void;
}) {
  const [invalidExpressionIds, setInvalidExpressionIds] = useState<Set<string>>(
    () => new Set()
  );
  const setExpressionValidity = useCallback((calculationId: string, valid: boolean) => {
    setInvalidExpressionIds((current) => {
      const next = new Set(current);
      if (valid) {
        next.delete(calculationId);
      } else {
        next.add(calculationId);
      }
      if (
        next.size === current.size &&
        [...next].every((value) => current.has(value))
      ) {
        return current;
      }
      return next;
    });
  }, []);

  useEffect(() => {
    const portableIds = new Set(
      manifest.calculations
        .filter((calculation) => calculation.kind === "portable")
        .map((calculation) => calculation.calculationId)
    );
    setInvalidExpressionIds((current) => {
      const next = new Set(
        [...current].filter((calculationId) => portableIds.has(calculationId))
      );
      return next.size === current.size ? current : next;
    });
  }, [manifest.calculations]);

  useEffect(() => {
    onValidityChange(invalidExpressionIds.size === 0);
  }, [invalidExpressionIds, onValidityChange]);

  const update = (mutator: (next: DashboardManifest) => void) => {
    const next = structuredClone(manifest);
    mutator(next);
    onChange(next);
  };

  return (
    <div
      className="dashboard-editor-form"
      inert={disabled}
      aria-busy={disabled}
    >
      <fieldset>
        <legend>Template identity</legend>
        <div className="dashboard-field-grid dashboard-field-grid--three">
          <label>
            Template ID
            <input
              disabled
              value={manifest.template.templateId}
              onChange={(event) => update((next) => { next.template.templateId = event.target.value; })}
            />
          </label>
          <label>
            Name
            <input
              value={manifest.template.name}
              onChange={(event) => update((next) => { next.template.name = event.target.value; })}
            />
          </label>
          <label>
            Version
            <input
              value={manifest.template.version}
              onChange={(event) => update((next) => { next.template.version = event.target.value; })}
            />
          </label>
        </div>
        <label>
          Description
          <textarea
            rows={3}
            value={manifest.template.description}
            onChange={(event) => update((next) => { next.template.description = event.target.value; })}
          />
        </label>
        <div className="dashboard-field-grid">
          <label>
            Preferred data adapter
            <select
              value={manifest.runtime.preferredAdapter}
              onChange={(event) => update((next) => {
                next.runtime.preferredAdapter = event.target.value as "fixture" | "qlik";
                next.runtime.fixtureId = event.target.value === "fixture"
                  ? next.runtime.fixtureId ?? "sales-overview-v1"
                  : null;
              })}
            >
              <option value="fixture">Synthetic fixture</option>
              <option value="qlik">Qlik (requires server configuration)</option>
            </select>
          </label>
          <label>
            Fixture ID
            <input
              disabled={manifest.runtime.preferredAdapter !== "fixture"}
              value={manifest.runtime.fixtureId ?? ""}
              onChange={(event) => update((next) => { next.runtime.fixtureId = event.target.value || null; })}
            />
          </label>
        </div>
      </fieldset>

      <fieldset>
        <legend>Parameters</legend>
        <div className="dashboard-editor-heading">
          <button
            type="button"
            className="text-button"
            onClick={() => update((next) => {
              const parameterId = uniqueId(
                "parameter",
                next.parameters.map((parameter) => parameter.parameterId)
              );
              next.parameters.push({
                parameterId,
                label: "New parameter",
                type: "number",
                defaultValue: 0,
                minimum: null,
                maximum: null,
                affects: "data"
              });
            })}
          >
            Add parameter
          </button>
        </div>
        <div className="dashboard-editor-records">
          {manifest.parameters.map((parameter, index) => (
            <article key={`${parameter.parameterId}-${String(index)}`} className="dashboard-editor-record">
              <div className="dashboard-field-grid dashboard-field-grid--three">
                <label>Stable ID<input disabled value={parameter.parameterId} /></label>
                <label>Label<input value={parameter.label} onChange={(event) => update((next) => { const value = next.parameters[index]; if (value) value.label = event.target.value; })} /></label>
                <label>
                  Type
                  <select value={parameter.type} onChange={(event) => update((next) => {
                    const value = next.parameters[index];
                    if (value) next.parameters[index] = parameterForType(value, event.target.value as DashboardParameter["type"]);
                  })}>
                    {(["string", "number", "boolean", "date", "enum"] as const).map((type) => <option key={type} value={type}>{type}</option>)}
                  </select>
                </label>
              </div>
              <div className="dashboard-field-grid dashboard-field-grid--three">
                <label>
                  Default
                  {parameter.type === "boolean" ? (
                    <select value={String(parameter.defaultValue)} onChange={(event) => update((next) => { const value = next.parameters[index]; if (value?.type === "boolean") value.defaultValue = event.target.value === "true"; })}>
                      <option value="false">False</option><option value="true">True</option>
                    </select>
                  ) : (
                    <input
                      type={parameter.type === "number" ? "number" : parameter.type === "date" ? "date" : "text"}
                      value={parameter.defaultValue}
                      onChange={(event) => update((next) => {
                        const value = next.parameters[index];
                        if (!value) return;
                        if (value.type === "number") value.defaultValue = numberValue(event);
                        else if (value.type !== "boolean") value.defaultValue = event.target.value;
                      })}
                    />
                  )}
                </label>
                <label>
                  Affects
                  <select value={parameter.affects} onChange={(event) => update((next) => { const value = next.parameters[index]; if (value) value.affects = event.target.value as "data" | "display" | "both"; })}>
                    <option value="data">Data</option><option value="display">Display</option><option value="both">Both</option>
                  </select>
                </label>
                {parameter.type === "enum" ? (
                  <label>Choices<input value={parameter.choices.join(", ")} onChange={(event) => update((next) => { const value = next.parameters[index]; if (value?.type === "enum") value.choices = event.target.value.split(",").map((choice) => choice.trim()).filter(Boolean); })} /></label>
                ) : parameter.type === "number" || parameter.type === "date" ? (
                  <label>Range<input value={`${parameter.minimum ?? ""}, ${parameter.maximum ?? ""}`} onChange={(event) => update((next) => {
                    const value = next.parameters[index];
                    const [minimum = "", maximum = ""] = event.target.value.split(",").map((part) => part.trim());
                    if (value?.type === "number") {
                      value.minimum = minimum === "" ? null : Number(minimum);
                      value.maximum = maximum === "" ? null : Number(maximum);
                    } else if (value?.type === "date") {
                      value.minimum = minimum || null;
                      value.maximum = maximum || null;
                    }
                  })} /></label>
                ) : <span />}
              </div>
              <button type="button" className="dashboard-remove-button" onClick={() => update((next) => { next.parameters.splice(index, 1); })}>Remove parameter</button>
            </article>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend>Data bindings</legend>
        <div className="dashboard-editor-heading">
          <button type="button" className="text-button" onClick={() => update((next) => {
            const bindingId = uniqueId("binding", next.bindings.map((binding) => binding.bindingId));
            next.bindings.push({ bindingId, sourceField: "source-field", role: "dimension", valueType: "string", format: null, nullHandling: "exclude" });
          })}>Add binding</button>
        </div>
        <div className="dashboard-editor-records">
          {manifest.bindings.map((binding, index) => (
            <article className="dashboard-editor-record" key={`${binding.bindingId}-${String(index)}`}>
              <div className="dashboard-field-grid dashboard-field-grid--three">
                <label>Stable ID<input disabled value={binding.bindingId} /></label>
                <label>Source field<input value={binding.sourceField} onChange={(event) => update((next) => { const value = next.bindings[index]; if (value) value.sourceField = event.target.value; })} /></label>
                <label>Role<select value={binding.role} onChange={(event) => update((next) => { const value = next.bindings[index]; if (value) value.role = event.target.value as typeof value.role; })}>
                  {(["dimension", "measure-input", "filter", "label"] as const).map((role) => <option key={role}>{role}</option>)}
                </select></label>
                <label>Value type<select value={binding.valueType} onChange={(event) => update((next) => { const value = next.bindings[index]; if (value) value.valueType = event.target.value as typeof value.valueType; })}>
                  {(["string", "number", "boolean", "date"] as const).map((type) => <option key={type}>{type}</option>)}
                </select></label>
                <label>Format<input value={binding.format ?? ""} onChange={(event) => update((next) => { const value = next.bindings[index]; if (value) value.format = event.target.value || null; })} /></label>
                <label>Nulls<select value={binding.nullHandling} onChange={(event) => update((next) => { const value = next.bindings[index]; if (value) value.nullHandling = event.target.value as typeof value.nullHandling; })}>
                  {(["exclude", "include", "zero", "empty"] as const).map((handling) => <option key={handling}>{handling}</option>)}
                </select></label>
              </div>
              <button type="button" className="dashboard-remove-button" onClick={() => update((next) => { next.bindings.splice(index, 1); })}>Remove binding</button>
            </article>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend>Calculations</legend>
        <div className="dashboard-editor-heading">
          <button type="button" className="text-button" onClick={() => update((next) => {
            const calculationId = uniqueId("calculation", next.calculations.map((calculation) => calculation.calculationId));
            next.calculations.push({ calculationId, label: "New calculation", kind: "portable", valueType: "number", format: null, expression: { kind: "literal", value: 0 } });
          })}>Add calculation</button>
        </div>
        <div className="dashboard-editor-records">
          {manifest.calculations.map((calculation, index) => (
            <article className="dashboard-editor-record" key={`${calculation.calculationId}-${String(index)}`}>
              <div className="dashboard-field-grid dashboard-field-grid--three">
                <label>Stable ID<input disabled value={calculation.calculationId} /></label>
                <label>Label<input value={calculation.label} onChange={(event) => update((next) => { const value = next.calculations[index]; if (value) value.label = event.target.value; })} /></label>
                <label>Runtime<select value={calculation.kind} onChange={(event) => update((next) => {
                  const value = next.calculations[index];
                  if (!value) return;
                  next.calculations[index] = event.target.value === "qlik"
                    ? { calculationId: value.calculationId, label: value.label, kind: "qlik", valueType: value.valueType, format: value.format, expression: "Sum([Measure])" }
                    : { calculationId: value.calculationId, label: value.label, kind: "portable", valueType: value.valueType, format: value.format, expression: { kind: "literal", value: 0 } };
                })}><option value="portable">Portable</option><option value="qlik">Qlik</option></select></label>
              </div>
              <label>
                {calculation.kind === "portable" ? "Portable expression" : "Qlik expression"}
                {calculation.kind === "portable" ? (
                  <PortableExpressionInput
                    calculationId={calculation.calculationId}
                    expression={calculation.expression}
                    disabled={disabled}
                    onBufferedChange={onBufferedChange}
                    onValidityChange={(valid) =>
                      setExpressionValidity(calculation.calculationId, valid)
                    }
                    onChange={(expression) =>
                      update((next) => {
                        const value = next.calculations[index];
                        if (value?.kind === "portable") value.expression = expression;
                      })
                    }
                  />
                ) : (
                  <textarea rows={3} value={calculation.expression} onChange={(event) => update((next) => { const value = next.calculations[index]; if (value?.kind === "qlik") value.expression = event.target.value; })} />
                )}
              </label>
              <button type="button" className="dashboard-remove-button" onClick={() => update((next) => { next.calculations.splice(index, 1); })}>Remove calculation</button>
            </article>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend>Components and table structure</legend>
        <div className="dashboard-editor-heading">
          <button type="button" className="text-button" onClick={() => update((next) => {
            const componentId = uniqueId("component", next.components.map((component) => component.componentId));
            next.components.push(componentForType({ componentId, title: "New component", adapter: "preferred", emptyState: "No data is available." }, "text", next));
            for (const breakpoint of ["large", "medium", "small"] as const) {
              const y = next.layout[breakpoint].reduce((maximum, item) => Math.max(maximum, item.y + item.height), 0);
              next.layout[breakpoint].push({ componentId, x: 0, y, width: 12, height: 2 });
            }
          })}>Add component</button>
        </div>
        <div className="dashboard-editor-records">
          {manifest.components.map((component, index) => (
            <article className="dashboard-editor-record" key={`${component.componentId}-${String(index)}`}>
              <div className="dashboard-field-grid dashboard-field-grid--three">
                <label>Stable ID<input disabled value={component.componentId} /></label>
                <label>Title<input value={component.title} onChange={(event) => update((next) => { const value = next.components[index]; if (value) value.title = event.target.value; })} /></label>
                <label>Type<select value={component.type} onChange={(event) => update((next) => { const value = next.components[index]; if (value) next.components[index] = componentForType(value, event.target.value as DashboardComponent["type"], next); })}>
                  {(["kpi", "data-table", "bar-chart", "line-chart", "filter", "text"] as const).map((type) => <option key={type} value={type}>{type}</option>)}
                </select></label>
              </div>
              <label>Empty state<input value={component.emptyState} onChange={(event) => update((next) => { const value = next.components[index]; if (value) value.emptyState = event.target.value; })} /></label>
              {component.type === "kpi" ? (
                <label>Calculation<select value={component.calculationId} onChange={(event) => update((next) => { const value = next.components[index]; if (value?.type === "kpi") value.calculationId = event.target.value; })}>{manifest.calculations.map((value) => <option key={value.calculationId}>{value.calculationId}</option>)}</select></label>
              ) : component.type === "data-table" ? (
                <div className="dashboard-column-editor">
                  <div className="dashboard-field-grid">
                    <label>Page size<input type="number" value={component.pageSize} onChange={(event) => update((next) => { const value = next.components[index]; if (value?.type === "data-table") value.pageSize = numberValue(event, 25); })} /></label>
                    <label>Selection<select value={component.selection} onChange={(event) => update((next) => { const value = next.components[index]; if (value?.type === "data-table") value.selection = event.target.value as typeof value.selection; })}><option>none</option><option>single</option><option>multiple</option></select></label>
                  </div>
                  {component.columns.map((column, columnIndex) => (
                    <div className="dashboard-table-column" key={`${column.columnId}-${String(columnIndex)}`}>
                      <label>Stable column ID<input disabled value={column.columnId} /></label>
                      <label>Header<input value={column.header} onChange={(event) => update((next) => { const value = next.components[index]; const target = value?.type === "data-table" ? value.columns[columnIndex] : undefined; if (target) target.header = event.target.value; })} /></label>
                      <label>Source<select value={`${column.source.kind}:${column.source.id}`} onChange={(event) => update((next) => { const value = next.components[index]; const target = value?.type === "data-table" ? value.columns[columnIndex] : undefined; if (!target) return; const [kind, id] = event.target.value.split(":"); if (kind === "binding" || kind === "calculation") target.source = { kind, id: id ?? "" }; })}>
                        {manifest.bindings.map((value) => <option key={`binding:${value.bindingId}`} value={`binding:${value.bindingId}`}>Binding · {value.bindingId}</option>)}
                        {manifest.calculations.map((value) => <option key={`calculation:${value.calculationId}`} value={`calculation:${value.calculationId}`}>Calculation · {value.calculationId}</option>)}
                      </select></label>
                      <button type="button" className="dashboard-remove-button" onClick={() => update((next) => { const value = next.components[index]; if (value?.type === "data-table") value.columns.splice(columnIndex, 1); })}>Remove column</button>
                    </div>
                  ))}
                  <button type="button" className="text-button" onClick={() => update((next) => { const value = next.components[index]; if (value?.type !== "data-table") return; const columnId = uniqueId(`${value.componentId}-column`, value.columns.map((column) => column.columnId)); value.columns.push({ columnId, source: { kind: "binding", id: next.bindings[0]?.bindingId ?? "binding-1" }, header: "New column", alignment: "start", width: 160, sort: "none", totalBehavior: "none" }); })}>Add table column</button>
                </div>
              ) : component.type === "bar-chart" || component.type === "line-chart" ? (
                <div className="dashboard-field-grid">
                  <label>Dimension<select value={component.dimensionBindingId} onChange={(event) => update((next) => { const value = next.components[index]; if (value?.type === "bar-chart" || value?.type === "line-chart") value.dimensionBindingId = event.target.value; })}>{manifest.bindings.map((value) => <option key={value.bindingId}>{value.bindingId}</option>)}</select></label>
                  <label>Calculations<select multiple value={component.calculationIds} onChange={(event) => update((next) => { const value = next.components[index]; if (value?.type === "bar-chart" || value?.type === "line-chart") value.calculationIds = Array.from(event.target.selectedOptions, (option) => option.value); })}>{manifest.calculations.map((value) => <option key={value.calculationId}>{value.calculationId}</option>)}</select></label>
                </div>
              ) : component.type === "filter" ? (
                <div className="dashboard-field-grid">
                  <label>Binding<select value={component.bindingId} onChange={(event) => update((next) => { const value = next.components[index]; if (value?.type === "filter") value.bindingId = event.target.value; })}>{manifest.bindings.map((value) => <option key={value.bindingId}>{value.bindingId}</option>)}</select></label>
                  <label className="dashboard-checkbox"><input type="checkbox" checked={component.multiSelect} onChange={(event) => update((next) => { const value = next.components[index]; if (value?.type === "filter") value.multiSelect = event.target.checked; })} /> Allow multiple values</label>
                </div>
              ) : component.type === "text" ? (
                <label>Plain text<textarea rows={3} value={component.text} onChange={(event) => update((next) => { const value = next.components[index]; if (value?.type === "text") value.text = event.target.value; })} /></label>
              ) : null}
              <button type="button" className="dashboard-remove-button" onClick={() => update((next) => {
                const removed = next.components[index];
                if (!removed) return;
                next.components.splice(index, 1);
                next.interactions = next.interactions.filter((interaction) => interaction.sourceComponentId !== removed.componentId && (!("targetComponentId" in interaction) || interaction.targetComponentId !== removed.componentId));
                for (const breakpoint of ["large", "medium", "small"] as const) next.layout[breakpoint] = next.layout[breakpoint].filter((item) => item.componentId !== removed.componentId);
              })}>Remove component</button>
            </article>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend>Responsive 12-column layout</legend>
        {(["large", "medium", "small"] as const).map((breakpoint) => (
          <details key={breakpoint} open={breakpoint === "large"}>
            <summary>{breakpoint} breakpoint</summary>
            <div className="dashboard-layout-table">
              {manifest.layout[breakpoint].map((placement, index) => (
                <div key={`${placement.componentId}-${String(index)}`}>
                  <code>{placement.componentId}</code>
                  {(["x", "y", "width", "height"] as const).map((field) => (
                    <label key={field}>{field}<input type="number" min={field === "x" || field === "y" ? 0 : 1} max={field === "x" ? 11 : field === "width" ? 12 : 10000} value={placement[field]} onChange={(event) => update((next) => { const value = next.layout[breakpoint][index]; if (value) value[field] = numberValue(event); })} /></label>
                  ))}
                </div>
              ))}
            </div>
          </details>
        ))}
      </fieldset>

      <fieldset>
        <legend>Theme tokens</legend>
        <div className="dashboard-theme-grid">
          {(["surface", "text", "accent", "success", "warning"] as const).map((token) => (
            <label key={token}>{token}<input type="color" value={manifest.theme[token]} onChange={(event) => update((next) => { next.theme[token] = event.target.value; })} /></label>
          ))}
          <label>Font scale<input type="number" min="0.75" max="1.5" step="0.05" value={manifest.theme.fontScale} onChange={(event) => update((next) => { next.theme.fontScale = numberValue(event, 1); })} /></label>
          <label>Spacing<select value={manifest.theme.spacing} onChange={(event) => update((next) => { next.theme.spacing = event.target.value as typeof next.theme.spacing; })}><option>compact</option><option>comfortable</option><option>spacious</option></select></label>
          <label>Radius<input type="number" min="0" max="24" value={manifest.theme.radius} onChange={(event) => update((next) => { next.theme.radius = numberValue(event); })} /></label>
        </div>
      </fieldset>

      <fieldset>
        <legend>Interactions</legend>
        <div className="dashboard-editor-heading">
          <button type="button" className="text-button" onClick={() => update((next) => {
            const interactionId = uniqueId("interaction", next.interactions.map((interaction) => interaction.interactionId));
            next.interactions.push(interactionForType(interactionId, "set-filter", next));
          })}>Add interaction</button>
        </div>
        <div className="dashboard-editor-records">
          {manifest.interactions.map((interaction, index) => (
            <article className="dashboard-editor-record" key={`${interaction.interactionId}-${String(index)}`}>
              <div className="dashboard-field-grid dashboard-field-grid--three">
                <label>Stable ID<input disabled value={interaction.interactionId} /></label>
                <label>Type<select value={interaction.type} onChange={(event) => update((next) => { const value = next.interactions[index]; if (value) next.interactions[index] = interactionForType(value.interactionId, event.target.value as DashboardInteraction["type"], next); })}>{(["set-filter", "clear-filter", "select-row", "select-chart-value", "navigate-section"] as const).map((type) => <option key={type}>{type}</option>)}</select></label>
                <label>Source component<select value={interaction.sourceComponentId} onChange={(event) => update((next) => { const value = next.interactions[index]; if (value) value.sourceComponentId = event.target.value; })}>{manifest.components.filter((component) => interaction.type === "select-row" ? component.type === "data-table" : interaction.type === "set-filter" || interaction.type === "select-chart-value" ? component.type === "bar-chart" || component.type === "line-chart" : true).map((value) => <option key={value.componentId}>{value.componentId}</option>)}</select></label>
                {"targetBindingId" in interaction ? <label>Target binding<select value={interaction.targetBindingId} onChange={(event) => update((next) => { const value = next.interactions[index]; if (value && "targetBindingId" in value) value.targetBindingId = event.target.value; })}>{manifest.bindings.map((value) => <option key={value.bindingId}>{value.bindingId}</option>)}</select></label> : null}
                {"targetComponentId" in interaction ? <label>Target component<select value={interaction.targetComponentId} onChange={(event) => update((next) => { const value = next.interactions[index]; if (value && "targetComponentId" in value) value.targetComponentId = event.target.value; })}>{manifest.components.map((value) => <option key={value.componentId}>{value.componentId}</option>)}</select></label> : null}
              </div>
              <button type="button" className="dashboard-remove-button" onClick={() => update((next) => { next.interactions.splice(index, 1); })}>Remove interaction</button>
            </article>
          ))}
        </div>
      </fieldset>
    </div>
  );
}
