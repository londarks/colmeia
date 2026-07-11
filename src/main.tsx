import ReactDOM from "react-dom/client";
import App from "./App";

// Estilos das bibliotecas de canvas e terminal.
import "@xyflow/react/dist/style.css";
import "@xterm/xterm/css/xterm.css";
import "./index.css";

// Sem StrictMode: o double-mount do dev derrubaria/re-subiria os PTYs.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />);
