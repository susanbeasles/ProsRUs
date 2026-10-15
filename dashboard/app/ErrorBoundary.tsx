import { Component, type ErrorInfo, type ReactNode } from "react";

/** Contains render failures to one view; a route change (resetKey) or "Try again" resets it. */
export class ErrorBoundary extends Component<{ resetKey: string; children: ReactNode }, { failed: boolean; key: string }> {
  override state = { failed: false, key: this.props.resetKey };

  static getDerivedStateFromError(): Partial<{ failed: boolean }> {
    return { failed: true };
  }

  static getDerivedStateFromProps(props: { resetKey: string }, state: { failed: boolean; key: string }) {
    return props.resetKey === state.key ? null : { failed: false, key: props.resetKey };
  }

  override componentDidCatch(_error: Error, _info: ErrorInfo) {
    // Errors are not logged or rendered: messages could contain workspace data.
    void _error;
    void _info;
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="error" role="alert">
        <p>This view could not be displayed.</p>
        <div className="actions">
          <button type="button" onClick={() => this.setState({ failed: false })}>
            Try again
          </button>
          <a href={typeof location === "undefined" ? "/owner/job-stack" : location.href}>Reload the dashboard</a>
        </div>
      </div>
    );
  }
}
