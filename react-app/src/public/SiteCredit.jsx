// Small persistent credit line for the public-facing candidate/entrance
// screens — kept as its own component so the text lives in exactly one place.
export default function SiteCredit() {
  return (
    <div className="site-credit">
      Designed &amp; developed by <span className="name">Amit Waghmare</span>
      {' · '}
      <a href="tel:7219308794">7219308794</a>
      {' · '}
      <a href="https://www.linkedin.com/in/amit-waghmare1357/" target="_blank" rel="noopener noreferrer">LinkedIn</a>
    </div>
  );
}
