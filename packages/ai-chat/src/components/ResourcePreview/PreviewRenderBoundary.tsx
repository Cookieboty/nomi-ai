import { createLogger, t } from '@nomi-ai/ui';
import React, { Component, type ErrorInfo, type ReactNode } from 'react';

import styles from './ResourcePreview.module.css';

const log = createLogger('preview-render');
interface Props {
  resetKey: string;
  children: ReactNode;
}
/** A renderer failure must leave tabs, mode controls and the saving session alive. */
export class PreviewRenderBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    log.error('File renderer failed', error, info);
  }
  componentDidUpdate(previous: Props) {
    if (this.state.failed && previous.resetKey !== this.props.resetKey)
      this.setState({ failed: false });
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className={styles.renderError} role="alert">
        <p>{t('ui.session-workspace.preview-render-error')}</p>
        <button type="button" onClick={() => this.setState({ failed: false })}>
          {t('ui.session-workspace.preview-render-retry')}
        </button>
      </div>
    );
  }
}
