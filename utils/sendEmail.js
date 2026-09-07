const nodemailer = require('nodemailer');

/**
 * Sends an email using Nodemailer.
 * Configured for Hostinger SMTP (smtp.hostinger.com), Gmail, or custom SMTP servers.
 * Falls back to console log output during local development if SMTP credentials are missing.
 */
const sendEmail = async (options) => {
    const smtpHost = process.env.SMTP_HOST;
    const smtpUser = process.env.SMTP_USER;
    const smtpPass = process.env.SMTP_PASS;

    // Development Console Output Fallback when SMTP is not configured
    if (!smtpHost || !smtpUser || !smtpPass) {
        console.log('\n------------------------------------------------------------');
        console.log('📧 [EMAIL UTILITY - DEV FALLBACK]');
        console.log(`To: ${options.email}`);
        console.log(`Subject: ${options.subject}`);
        console.log('Message / Reset Link:');
        console.log(options.message || options.html);
        console.log('------------------------------------------------------------\n');
        return { success: true, mode: 'console-log' };
    }

    const port = Number(process.env.SMTP_PORT) || 465;
    const isSecure = process.env.SMTP_SECURE === 'true' || port === 465;

    // Create Transporter
    const transporter = nodemailer.createTransport({
        host: smtpHost,
        port: port,
        secure: isSecure, // true for 465 (Hostinger SSL), false for 587 (TLS)
        auth: {
            user: smtpPass ? smtpUser : undefined,
            pass: smtpPass || undefined,
        },
        tls: {
            rejectUnauthorized: false, // Prevents self-signed cert issues on custom hosts
        },
    });

    const mailOptions = {
        from: process.env.FROM_EMAIL || `"Sanrachna Prahari" <${smtpUser}>`,
        to: options.email,
        subject: options.subject,
        text: options.message,
        html: options.html,
    };

    const info = await transporter.sendMail(mailOptions);
    console.log(`✉️ Email sent successfully to ${options.email}: ${info.messageId}`);
    return info;
};

module.exports = sendEmail;
