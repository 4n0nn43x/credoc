import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./landing.css";
import { Landing } from "./Landing";
import { trackPageView } from "../shared/track";

trackPageView();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Landing />
  </StrictMode>,
);
