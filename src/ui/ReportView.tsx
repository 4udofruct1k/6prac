import { useState } from 'preact/hooks';

/** JSON-отчёт M0: устройство, самопроверка, бенчмарк — чтобы перенести числа с телефона в спеку. */
export function ReportView({ report }: { report: unknown }) {
  const text = JSON.stringify(report, null, 2);
  const [copied, setCopied] = useState<string | null>(null);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied('Скопировано');
    } catch {
      // В WebView буфер обмена бывает закрыт — выделяем текст для ручного копирования
      const ta = document.querySelector<HTMLTextAreaElement>('textarea.report');
      ta?.select();
      setCopied('Буфер обмена недоступен — текст выделен, скопируйте вручную');
    }
  };

  return (
    <section class="report">
      <p class="note">
        Запустите «Самопроверку» на вкладке «Устройство» и бенчмарк, затем скопируйте отчёт — по нему фиксируются числа
        пресетов (гейт M0).
      </p>
      <div class="controls">
        <button class="primary" onClick={copy}>
          Скопировать JSON
        </button>
        {copied && <span class="dim">{copied}</span>}
      </div>
      <textarea class="report" readOnly value={text} />
    </section>
  );
}
