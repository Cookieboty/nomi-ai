import { createLogger, t, Icon } from '@nomi-ai/ui';
import { TriangleAlert } from 'lucide-react';
import React, { Component, type ErrorInfo, type ReactNode } from 'react';

import styles from './index.module.css';

const log = createLogger('error-boundary');

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error?: Error;
  errorInfo?: ErrorInfo;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    log.error('AI Chat Error Boundary caught an error:', error, errorInfo);
    this.setState({ error, errorInfo });
  }

  handleReload = () => {
    this.setState({ hasError: false, error: undefined, errorInfo: undefined });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className={styles.errorBoundary}>
          <div className={styles.errorContainer}>
            <div className={styles.errorIcon}>
              <Icon icon={TriangleAlert} size={36} />
            </div>
            <h2 className={styles.errorTitle}>{t('出现了一些问题')}</h2>
            <p className={styles.errorMessage}>{t('AI对话应用遇到了意外错误，请尝试重新加载。')}</p>

            {this.state.error && (
              <details className={styles.errorDetails}>
                <summary>{t('错误详情')}</summary>
                <pre className={styles.errorStack}>
                  {this.state.error.toString()}
                  {this.state.errorInfo?.componentStack}
                </pre>
              </details>
            )}

            <div className={styles.errorActions}>
              <button className={styles.reloadButton} onClick={this.handleReload}>
                {t('重新加载')}
              </button>
              <button className={styles.refreshButton} onClick={() => window.location.reload()}>
                {t('刷新页面')}
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
