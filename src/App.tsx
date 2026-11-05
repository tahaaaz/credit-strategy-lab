import { useEffect, useState } from "react";
import LimitStrategy from "./pages/LimitStrategy";
import Method from "./pages/Method";
import Model from "./pages/Model";
import Portfolio from "./pages/Portfolio";
import Pricing from "./pages/Pricing";

const PAGES = [
  { id: "portfolio", label: "Portfolio", hint: "where value sits", el: <Portfolio /> },
  { id: "model", label: "Risk model", hint: "PD scorecard", el: <Model /> },
  { id: "limits", label: "Limit strategy", hint: "CLI simulator", el: <LimitStrategy /> },
  { id: "pricing", label: "Pricing strategy", hint: "APR re-pricing", el: <Pricing /> },
  { id: "method", label: "Method", hint: "assumptions", el: <Method /> },
];

const REPO_URL = import.meta.env.VITE_REPO_URL as string | undefined;

function current() {
  const id = window.location.hash.replace(/^#\/?/, "");
  return PAGES.some((p) => p.id === id) ? id : "portfolio";
}

export default function App() {
  const [page, setPage] = useState(current);
  useEffect(() => {
    const on = () => { setPage(current()); window.scrollTo(0, 0); };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const active = PAGES.find((p) => p.id === page)!;
  useEffect(() => { document.title = `${active.label}: Credit Strategy Lab`; }, [active]);

  return (
    <div className="shell">
      <aside className="rail">
        <div className="brand">
          Credit Strategy Lab
          <small>Limit and pricing decisions for a UK credit card book</small>
        </div>
        <nav className="nav" aria-label="Sections">
          {PAGES.map((p) => (
            <a key={p.id} href={`#/${p.id}`} aria-current={p.id === page ? "page" : undefined}>
              {p.label} <span>{p.hint}</span>
            </a>
          ))}
        </nav>
        <div className="rail-foot">
          All customer data is synthetic: 30,000 simulated accounts built to behave like a real card portfolio.
          {REPO_URL && <><br /><a href={REPO_URL}>Source code on GitHub</a></>}
        </div>
      </aside>
      <main>{active.el}</main>
    </div>
  );
}
