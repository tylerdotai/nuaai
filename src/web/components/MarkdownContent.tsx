import { type ReactElement, type ReactNode, isValidElement, memo, useState } from 'react';
import ReactMarkdown, { type Components, defaultUrlTransform } from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';

function safeUrlTransform(url: string): string {
  const trimmed = url.trim();
  if (
    trimmed.startsWith('#') ||
    trimmed.startsWith('/') ||
    trimmed.startsWith('./') ||
    trimmed.startsWith('../')
  )
    return defaultUrlTransform(trimmed);
  if (/^(https?:|mailto:)/i.test(trimmed)) return defaultUrlTransform(trimmed);
  return '';
}

function CodeBlock({ children }: { children?: ReactNode }): React.JSX.Element {
  const codeElement = isValidElement(children)
    ? (children as ReactElement<{ className?: string; children?: ReactNode }>)
    : null;
  const className = codeElement?.props.className ?? '';
  const language = className.match(/language-([\w-]+)/)?.[1] ?? 'text';
  const code = String(codeElement?.props.children ?? '').replace(/\n$/, '');
  const [copied, setCopied] = useState(false);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="code-block" data-language={language}>
      <div className="code-block-header">
        <span>{language}</span>
        <button type="button" aria-label="Copy code block" onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre>
        <code className={className}>{code}</code>
      </pre>
    </div>
  );
}

const markdownComponents: Components = {
  pre: CodeBlock,
  a: ({ href = '', children, ...props }) => {
    const external = /^https?:\/\//i.test(href);
    return (
      <a
        {...props}
        href={href}
        {...(external ? { target: '_blank', rel: 'noreferrer noopener' } : {})}
      >
        {children}
      </a>
    );
  },
  img: ({ alt = '' }) => (
    <span className="blocked-markdown-image">[Image: {alt || 'untitled'}]</span>
  ),
};

export const MarkdownContent = memo(function MarkdownContent({
  markdown,
  className = '',
}: {
  markdown: string;
  className?: string;
}): React.JSX.Element {
  return (
    <div className={`markdown-content ${className}`.trim()}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        skipHtml
        urlTransform={safeUrlTransform}
        components={markdownComponents}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
});
