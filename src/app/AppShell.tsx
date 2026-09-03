import { NavLink, Outlet } from "react-router-dom";

const links = [
  { to: "/", label: "Overview", end: true },
  { to: "/showcase", label: "Component lab" },
  { to: "/playground", label: "Interaction lab" },
  { to: "/tokens", label: "Token parity" },
];

export function AppShell() {
  return (
    <div className="app-shell">
      <header className="topbar">
        <NavLink className="brand" to="/">
          <span className="brand-mark" aria-hidden="true">
            M
          </span>
          <span>Moka Canvas</span>
        </NavLink>
        <nav aria-label="Primary navigation" className="nav-links">
          {links.map(({ to, label, end }) => (
            <NavLink
              className={({ isActive }) =>
                `nav-link${isActive ? " is-active" : ""}`
              }
              end={end}
              key={to}
              to={to}
            >
              {label}
            </NavLink>
          ))}
        </nav>
        <span className="runtime-pill">Browser ↔ Tauri</span>
      </header>
      <main className="page-content">
        <Outlet />
      </main>
    </div>
  );
}
