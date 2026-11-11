import type { LinkComponent } from "./types";

export interface HelpItem {
  href: string;
  title: string;
  description: string;
  /** A Font Awesome class string, such as `fas fa-headset`. */
  icon: string;
}

export interface HelpStripProps {
  items: HelpItem[];
  linkAs?: LinkComponent;
}

/** The help cards of index.html (live chat, ticket, knowledge base). */
export function HelpStrip({ items, linkAs }: HelpStripProps) {
  if (items.length === 0) throw new RangeError("HelpStrip: items must hold at least one item");
  const Link = linkAs;
  return (
    <section className="services help pt-4">
      <div className="container">
        <div className="service-wrap">
          <div className="row">
            {items.map((item) => {
              const content = (
                <>
                  <div className="img">
                    <i className={`${item.icon} ico tc-help-icon`} aria-hidden="true" />
                  </div>
                  <div className="inform">
                    <div className="title mergecolor">{item.title}</div>
                    <div className="description seccolor">{item.description}</div>
                  </div>
                </>
              );
              return (
                <div key={item.href} className="col-sm-12 col-md-6 col-lg-4">
                  <div className="help-container bg-seccolorstyle noshadow">
                    {Link ? (
                      <Link href={item.href} className="help-item">
                        {content}
                      </Link>
                    ) : (
                      <a href={item.href} className="help-item">
                        {content}
                      </a>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
