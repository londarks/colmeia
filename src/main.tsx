import ReactDOM from "react-dom/client";
import { ReactFlowProvider } from "@xyflow/react";
import App from "./App";

// Estilos das bibliotecas de canvas e terminal.
import "@xyflow/react/dist/style.css";
import "@xterm/xterm/css/xterm.css";
// Visual do app (linguagem portada do app "markdown"): temas → base → casca →
// nós → painéis → overlays. Cores só via tokens de src/styles/themes/.
import "./styles/themes/index.css";
import "./styles/base.css";
import "./styles/shell.css";
import "./styles/nodes.css";
import "./styles/panels.css";
import "./styles/overlays.css";

// Sem StrictMode: o double-mount do dev derrubaria/re-subiria os PTYs.
// O provider fica por fora do App para que os hooks de canvas (câmera, undo,
// atalhos, partituras, clipboard, drop, grupos) possam usar `useReactFlow()`.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <ReactFlowProvider>
    <App />
  </ReactFlowProvider>,
);
