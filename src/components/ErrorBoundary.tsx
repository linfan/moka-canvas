import { Component, type ReactNode } from "react";
import { i18n } from "../shared/i18n";

interface Props {
  children: ReactNode;
}
interface State {
  /**
   * What was thrown, kept rather than only noted.
   *
   * The sentence says what happened to the screen; the error says what broke,
   * and it is the only thing here that could be acted on or reported.
   */
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  render() {
    const { error } = this.state;
    if (error !== null) {
      return (
        <div className="error-state">
          <p>{i18n.t("app:initFailed")}</p>
          <p className="error-state-reason">{error.message}</p>
        </div>
      );
    }
    return this.props.children;
  }
}
