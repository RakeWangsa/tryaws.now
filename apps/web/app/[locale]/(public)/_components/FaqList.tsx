/**
 * WPU-Z16: questions and answers as a description list (`dl`, `dt`, `dd`), in the classes of the
 * mockup's FAQ (`accordion faq`, `panel-title`, `wrapper-collapse`). Every answer is in the server
 * HTML and visible without a script, for readers and for crawlers and answer engines alike; the
 * FAQPage JSON-LD of the page lists the same questions and answers in the same order.
 */
export function FaqList({ items }: { items: readonly { question: string; answer: string }[] }) {
  return (
    <dl className="accordion faq">
      {items.map((item) => (
        <div className="panel-wrap" key={item.question}>
          <dt className="panel-title mergecolor tc-faq-q">{item.question}</dt>
          <dd className="wrapper-collapse">
            <p className="info seccolor mb-0">{item.answer}</p>
          </dd>
        </div>
      ))}
    </dl>
  );
}
