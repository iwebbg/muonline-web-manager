# MuOnline Web Manager — Installation Guide

**Powered by [InterWeb Ltd.](https://interweb.bg)**

In this video, we will install MuOnline Web using MuOnline Web Manager.
We will prepare SQL Server, check the connection, and install the website.

[MuOnline Web source code](https://github.com/iwebbg/muonline-web-laravel)

## Video walkthrough

The YouTube installation walkthrough will be linked here when it is published.

<!-- Replace this note with: [Watch the installation guide on YouTube](ACTUAL_VIDEO_URL). -->

## Before you begin

This demonstration uses SQL Server 2019 Express and SQL Server Management
Studio (SSMS). The instance name in this example is SQLEXPRESS.
If your instance has a different name, use that name instead.

## 1. Enable SQL Server TCP/IP connections

1. Open **SQL Server Configuration Manager**.
2. In the left panel, expand **SQL Server Network Configuration**.
3. Select **Protocols for SQLEXPRESS**.
4. Right-click **TCP/IP** and select Properties.
5. On the Protocol tab, set Enabled to Yes.
6. For this setup, set **Listen All** to Yes.
7. Open the IP Addresses tab and scroll down to **IPAll**.
8. Clear **TCP Dynamic Ports**. Leave it empty; do not enter 0.
9. Set **TCP Port** to 1433, then click OK.

These changes take effect after restarting the SQL Server service.
We will restart it after checking the authentication settings below.

> **Important:** Enabling **TCP/IP** does not automatically open port 1433 to the internet.

For this setup, SQL Server and the manager are on the same Windows machine.
The manager configures the scoped firewall access needed by its website
containers. Do not forward SQL port 1433 through your router for this setup.

If SQL Server is on another machine or in the cloud, configure its network
and firewall access to allow the website host to connect securely.

## 2. Enable SQL Server authentication

1. Open **SQL Server Management Studio**.
2. In **Object Explorer**, select **Connect > Database Engine**.
3. Enter `.\SQLEXPRESS` as the server name.
4. Select **Windows Authentication**.
5. If your connection dialog offers **Trust server certificate**, enable it
   only if you accept the local server's unverified certificate.
6. Click Connect.
7. Right-click the connected server in **Object Explorer** and select Properties.
8. Open the Security page.
9. Under Server authentication, select:
   **SQL Server and Windows Authentication mode**.
10. Click OK.

If this mode was already selected, leave it unchanged.

## 3. Prepare a temporary SQL administrator login

The installer needs a SQL administrator to create the web database and
configure the restricted SQL logins used by the website.
This example uses sa. You can use another authorized SQL administrator.

1. In SSMS, expand Security > Logins.
2. Right-click sa and select Properties.
3. On the General page, enter a strong password in Password and
   Confirm password. Keep it private.
4. Open the Status page and set Login to Enabled.
5. Click OK.

Now apply the SQL Server configuration changes:

1. Return to **SQL Server Configuration Manager**.
2. Select SQL Server Services.
3. Right-click SQL Server (SQLEXPRESS) and select Restart.

Restart the Database Engine service for the instance you are configuring.
Restarting SSMS alone does not apply these changes.

## 4. Test the SQL administrator login

1. In SSMS, select **Connect > Database Engine**.
2. Enter `.\SQLEXPRESS` as the server name.
3. Select **SQL Server Authentication**.
4. Enter sa and the password you set in the previous step.
5. If needed for your local certificate, select **Trust server certificate**.
6. Click Connect.

If the connection succeeds, the administrator login works.
This confirms the login in SSMS; the manager will also check connectivity
from the website environment during installation.

Make sure your existing MuOnline game database is available before you
continue. The manager configures website access to that database; it does
not install the MuServer or create a complete game database from scratch.

## 5. Install MuOnline Web Manager

1. [Download the Windows installer](https://mega.nz/file/eFMFlZpS#R2T1iPSjXT7faTfhDy6CHrDKuujMivODo50m8Ati2Fs).
2. Run the installer and follow the setup instructions.
3. Launch MuOnline Web Manager.
4. Choose English or Bulgarian from the language selector.
5. Open **First installation** if it is not already displayed.

**Allow about 15 minutes for a first installation.** The actual time depends
on your computer and internet connection. One or more Windows restarts
may be required while the website environment is being prepared.

If you are testing inside a virtual machine, nested virtualization must
be available and enabled for WSL2 to work.

## 6. Enter the website installation settings

### SQL Server

1. If SQL Server is on this Windows machine, use **Detect local SQL Server**
   to find a suitable connection address. The installer can replace a
   local address with the Windows host address reachable by its containers.
   Do not assume that `127.0.0.1` inside a container points to Windows.
2. If you use an external SQL Server, enter that server's hostname or IP.
3. Enter the SQL TCP port. This example uses 1433.
4. Enter the temporary SQL administrator login and password.
5. Select the **MuServer Version** that matches your game server.
6. Select the Laravel application environment: local for testing or
   production for a live website.
7. Enter the existing game database name. This example uses MuOnline.
8. Choose a separate web database name. This example uses MuOnline_Web.
9. Review the restricted application and game SQL login names.
   The manager generates their passwords automatically.
10. Review **Trust SQL Server certificate**. Keep it enabled only if you
    accept an unverified SQL Server certificate for this connection.

### Website access

Choose one of the following access modes:

- **Local:** use the website on this computer at http://localhost.
- **IP:** access the website over HTTP using the host's IP address.
  HTTP does not encrypt passwords or sessions. Read the warning before
  accepting this mode.
- **Domain + SSL:** use a domain with HTTPS. This is the recommended mode
  for a public production website.

For Domain + SSL, enter your domain name and certificate contact email.
Point the domain's DNS record to your public IP and forward TCP ports
80 and 443 to the Windows website host if it is behind a router.
External firewall rules must also allow access to those ports.

The access mode and Laravel application environment are separate settings.
You can change the access mode later under **Access and SSL**.

### First web administrator

Enter the administrator's name, email address, and password.
Use at least 12 characters, including uppercase and lowercase letters,
a number, and a special character.

This account is for the website administration panel. It is separate
from the temporary SQL administrator login.

## 7. Start the installation

1. Click **Install MuOnline Web**.
2. Approve the Windows permission prompt when requested.
3. Keep the manager open and follow the progress messages.
4. If the manager requests a Windows restart, restart the computer.
5. Reopen the manager after signing back in.
6. Review the saved settings and re-enter the required passwords.
   Non-password installation settings are saved between restarts.
7. Use **Resume interrupted installation** to continue.
8. Follow any further restart instructions shown by the manager.

The manager prepares WSL2 and Docker Engine, downloads the latest tagged
web release after verifying its signed release manifest, configures database
access, runs migrations, generates the application encryption key, and creates the first web administrator.
Temporary SQL bootstrap credentials are removed after a successful setup.

If installation fails, read the error in **Operations** and use **SQL Troubleshooting** when the error concerns SQL Server. Correct the settings
and resume the installation instead of immediately starting over.
Do not share passwords or the website's `.env` file when requesting help.

## 8. Open your website

When installation finishes, a success message appears and the manager
switches to the **Control panel**.

1. Check that the website services are running.
2. Click **Open Website** to visit the website.
3. Click **Open Admin Panel** and sign in with your web administrator account.

For Local mode, the default addresses are:

| Destination | Address |
| --- | --- |
| Website | http://localhost |
| Admin panel | http://localhost/admin |

For IP or Domain + SSL mode, the buttons use your configured address.

Closing the manager keeps the website services running.
The host must remain awake and connected for the website to stay available.

## 9. Backups and future updates

The manager checks for newer versions automatically. Updates are applied
only when you click Update; they are not installed automatically.

Before updating, enter the temporary SQL backup credentials and an existing
absolute backup directory on the SQL Server machine, such as `D:\MuBackups`.
The SQL Server service account must have permission to write there.
The manager creates and verifies a SQL backup before applying the update.

Website settings, the application encryption key, uploads, and custom
themes are preserved. Database migrations do not have automatic rollback.

## Support the project

[Buy Me a Coffee](https://buymeacoffee.com/interweb.bg) ·
[Ko-fi](https://ko-fi.com/interwebltd) ·
[PayPal](https://paypal.me/interwebltd)

[InterWeb Ltd.](https://interweb.bg)
