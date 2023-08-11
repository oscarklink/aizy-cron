import cron from 'node-cron';
import axios from 'axios';
import { Client } from 'pg'; // Make sure to install the pg package

// Database configuration
const dbConfig = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 5432, // Default PostgreSQL port
};

cron.schedule('0 4 * * *', async () => {
  const client = new Client(dbConfig);

  try {
    await client.connect();

    // Fetch rows from the "sharepoint_webhooks" table
    const rows = await fetchRowsFromDatabase(client);

    for (const row of rows) {
      const { webhook_external_id, account_id, expiration_date } = row;

      // Fetch additional data from the "connect_sharepoint" table
      const connectSharepointData = await fetchConnectSharepointData(client, account_id);

      if (connectSharepointData) {
        const { access_token, tenant_id } = connectSharepointData;

        // Calculate if the expiration_date is within 3 days from today
        const today = new Date();
        const expirationDate = new Date(expiration_date);
        const daysDifference = Math.floor((expirationDate - today) / (1000 * 60 * 60 * 24));

        if (daysDifference <= 3) {
          // Refresh the access token and update the database
          const refreshedAccessToken = await refreshAccessToken(tenant_id);

          if (refreshedAccessToken) {
            // Update the access token in the database
            await updateAccessTokenInDatabase(client, account_id, refreshedAccessToken);

            // Extend the expiration date of the webhook by 30 days
            const updatedExpirationDate = new Date(today.setDate(today.getDate() + 30));
            await updateExpirationDateInDatabase(client, webhook_external_id, updatedExpirationDate);
          } else {
            console.error('Failed to refresh access token.');
          }
        }
      }
    }
  } catch (error) {
    console.error('Error in cron job:', error);
  } finally {
    await client.end();
  }
});

async function fetchRowsFromDatabase(client) {
  const { rows } = await client.query('SELECT * FROM sharepoint_webhooks');
  return rows;
}

async function fetchConnectSharepointData(client, accountId) {
  const { rows } = await client.query('SELECT access_token, tenant_id FROM connect_sharepoint WHERE account_id = $1', [accountId]);
  return rows[0];
}

async function updateAccessTokenInDatabase(client, accountId, accessToken) {
  await client.query('UPDATE connect_sharepoint SET access_token = $1 WHERE account_id = $2', [accessToken, accountId]);
}

async function updateExpirationDateInDatabase(client, webhookId, expirationDate) {
  await client.query('UPDATE sharepoint_webhooks SET expiration_date = $1 WHERE webhook_external_id = $2', [
    expirationDate,
    webhookId,
  ]);
}

async function refreshAccessToken(tenantId) {
  const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
  const tokenData = {
    client_id: process.env.SHAREPOINT_CLIENT_ID,
    client_secret: process.env.SHAREPOINT_CLIENT_SECRET,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  };

  try {
    const tokenResponse = await axios.post(tokenUrl, new URLSearchParams(tokenData));
    if (tokenResponse.status === 200) {
      return tokenResponse.data.access_token;
    } else {
      return null;
    }
  } catch (error) {
    console.error('Error refreshing access token:', error);
    return null;
  }
}
