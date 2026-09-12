import { useAppStore } from "../stores/appStore";

export function BootScreen() {
  return (
    <div className="boot-screen">
      <img
        alt=""
        aria-hidden="true"
        className="brand-mark"
        src="/favicon.png"
      />
      <p>Starting Moka Canvas…</p>
    </div>
  );
}

export function BootErrorScreen() {
  const bootError = useAppStore((state) => state.bootError);
  return (
    <div className="boot-screen">
      <img
        alt=""
        aria-hidden="true"
        className="brand-mark"
        src="/favicon.png"
      />
      <h1>Moka Canvas could not start</h1>
      <p role="alert">{bootError ?? "Unknown error"}</p>
      <button onClick={() => void useAppStore.getState().boot()} type="button">
        Retry
      </button>
    </div>
  );
}
