import { Component, type ReactNode } from "react";
import { i18n } from "../shared/i18n";

interface Props {
  children: ReactNode;
}
interface State {
  hasError: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return <div className="error-state">{i18n.t("app:initFailed")}</div>;
    }
    return this.props.children;
  }
}
