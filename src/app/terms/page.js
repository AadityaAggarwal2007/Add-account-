export const metadata = {
  title: 'Terms of Service — Add ERP',
  description: 'Terms of Service for AD Manager Meta Ads Manager',
};

export default function TermsPage() {
  return (
    <main style={{ maxWidth: '800px', margin: '0 auto', padding: '60px 24px', fontFamily: 'system-ui, sans-serif', color: '#1a1a1a', lineHeight: '1.7' }}>
      <h1 style={{ fontSize: '2rem', fontWeight: '700', marginBottom: '8px' }}>Terms of Service</h1>
      <p style={{ color: '#666', marginBottom: '40px' }}>Last updated: June 2026</p>

      <section style={{ marginBottom: '32px' }}>
        <h2 style={{ fontSize: '1.25rem', fontWeight: '600', marginBottom: '12px' }}>1. Acceptance of Terms</h2>
        <p>By accessing or using Add ERP ("the app") at <strong>krvvy.info</strong>, you agree to be bound by these Terms of Service. If you do not agree, please do not use the application.</p>
      </section>

      <section style={{ marginBottom: '32px' }}>
        <h2 style={{ fontSize: '1.25rem', fontWeight: '600', marginBottom: '12px' }}>2. Description of Service</h2>
        <p>Add ERP is a private Meta Ads management dashboard that allows authorized users to:</p>
        <ul style={{ paddingLeft: '24px', marginTop: '8px' }}>
          <li>View and manage Facebook and Instagram ad campaigns</li>
          <li>Monitor ad performance metrics and analytics</li>
          <li>Set up automated rules for ad management (pause/resume based on conditions)</li>
          <li>Manage Page comments and inbox messages</li>
          <li>Access business portfolio and ad account data</li>
        </ul>
      </section>

      <section style={{ marginBottom: '32px' }}>
        <h2 style={{ fontSize: '1.25rem', fontWeight: '600', marginBottom: '12px' }}>3. Eligibility</h2>
        <p>This application is intended for private use by authorized administrators only. Access is controlled via login credentials provided by the app owner. Unauthorized access is strictly prohibited.</p>
      </section>

      <section style={{ marginBottom: '32px' }}>
        <h2 style={{ fontSize: '1.25rem', fontWeight: '600', marginBottom: '12px' }}>4. Meta Platform Compliance</h2>
        <p>By using this app, you agree to comply with:</p>
        <ul style={{ paddingLeft: '24px', marginTop: '8px' }}>
          <li><a href="https://developers.facebook.com/terms/" style={{ color: '#1877f2' }}>Meta Platform Terms</a></li>
          <li><a href="https://www.facebook.com/policies/ads/" style={{ color: '#1877f2' }}>Meta Advertising Policies</a></li>
          <li>All applicable laws and regulations regarding advertising and data use</li>
        </ul>
      </section>

      <section style={{ marginBottom: '32px' }}>
        <h2 style={{ fontSize: '1.25rem', fontWeight: '600', marginBottom: '12px' }}>5. User Responsibilities</h2>
        <p>You are responsible for:</p>
        <ul style={{ paddingLeft: '24px', marginTop: '8px' }}>
          <li>Maintaining the confidentiality of your login credentials</li>
          <li>All actions taken through your account</li>
          <li>Ensuring your ad campaigns comply with Meta's advertising policies</li>
          <li>Any consequences resulting from automated rules you configure</li>
          <li>Monitoring ad spend affected by automation rules</li>
        </ul>
      </section>

      <section style={{ marginBottom: '32px' }}>
        <h2 style={{ fontSize: '1.25rem', fontWeight: '600', marginBottom: '12px' }}>6. Disclaimer of Warranties</h2>
        <p>The app is provided "as is" without warranties of any kind. We do not guarantee uninterrupted access or that automated rules will perform without error. Ad spending decisions remain your sole responsibility.</p>
      </section>

      <section style={{ marginBottom: '32px' }}>
        <h2 style={{ fontSize: '1.25rem', fontWeight: '600', marginBottom: '12px' }}>7. Limitation of Liability</h2>
        <p>We shall not be liable for any indirect, incidental, or consequential damages arising from your use of the app, including but not limited to ad spend losses resulting from automation errors.</p>
      </section>

      <section style={{ marginBottom: '32px' }}>
        <h2 style={{ fontSize: '1.25rem', fontWeight: '600', marginBottom: '12px' }}>8. Changes to Terms</h2>
        <p>We reserve the right to modify these Terms at any time. Continued use of the app after changes constitutes acceptance of the updated Terms.</p>
      </section>

      <section style={{ marginBottom: '32px' }}>
        <h2 style={{ fontSize: '1.25rem', fontWeight: '600', marginBottom: '12px' }}>9. Contact</h2>
        <p>For questions about these Terms, contact:<br />
        <a href="mailto:cargonicshop@gmail.com" style={{ color: '#1877f2' }}>cargonicshop@gmail.com</a></p>
        <p style={{ marginTop: '8px' }}>Website: <a href="https://www.krvvy.info" style={{ color: '#1877f2' }}>www.krvvy.info</a></p>
      </section>
    </main>
  );
}
