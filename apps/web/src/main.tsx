import { CopilotKit } from "@copilotkit/react-core/v2";
import "@copilotkit/react-ui/v2/styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

const root = document.getElementById("root");

if (root === null) {
  throw new Error("The application root element is missing.");
}

createRoot(root).render(
  <StrictMode>
    <CopilotKit
      runtimeUrl="/api/copilotkit"
      agent="default"
      useSingleEndpoint={false}
      showDevConsole={false}
    >
      <App />
    </CopilotKit>
  </StrictMode>
);
