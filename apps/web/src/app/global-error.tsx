'use client';

import { Button } from '@/components/design-system/primitives';


export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="ru">
      <body style={{ margin: 0, background: '#0a0b0d', color: '#eaecf1', fontFamily: 'system-ui, sans-serif' }}>
        <main style={{ minHeight: '100dvh', padding: 24, display: 'grid', placeItems: 'center' }}>
          <section style={{ width: 'min(480px, 100%)', display: 'flex', flexDirection: 'column', gap: 14 }}>
            <h1 style={{ margin: 0, fontSize: 24 }}>Приложение не загрузилось</h1>
            <p style={{ margin: 0, color: '#9096a3', lineHeight: 1.5 }}>
              Повтори попытку. Текущая страница не будет перезагружена без твоего действия.
            </p>
            <Button variant="bare"
              type="button"
              onClick={reset}
              style={{
                width: 'fit-content',
                minHeight: 40,
                padding: '0 16px',
                border: '1px solid #5a8f2a',
                borderRadius: 10,
                background: '#7bb53a',
                color: '#0d1608',
                font: 'inherit',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Повторить
            </Button>
          </section>
        </main>
      </body>
    </html>
  );
}
