import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

export async function render(ui: ReactNode): Promise<{
  container: HTMLDivElement;
  unmount: () => Promise<void>;
}> {
  const container = document.createElement("div");
  document.body.append(container);
  const root: Root = createRoot(container);

  await act(async () => {
    root.render(ui);
  });

  return {
    container,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  };
}
