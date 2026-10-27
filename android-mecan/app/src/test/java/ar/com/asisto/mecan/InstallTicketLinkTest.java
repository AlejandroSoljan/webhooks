package ar.com.asisto.mecan;
import org.junit.Test;
import static org.junit.Assert.*;

public class InstallTicketLinkTest {
    private static final String ID = "0123456789abcdef01234567";
    private static final String CODE = "a".repeat(43);
    private static final String VALID = "mecan_ticket=" + ID + "&mecan_code=" + CODE;
    @Test public void restoresTheSameTicketOnCanonicalMecanUrl() {
        assertEquals("https://asistobot.com.ar/customer-app/MCN?view=ticket&claim=" + ID + "#code=" + CODE,
            InstallTicketLink.fromReferrer(VALID));
    }
    @Test public void ignoresCampaignAndRedirectUrls() {
        assertEquals(InstallTicketLink.fromReferrer(VALID), InstallTicketLink.fromReferrer("utm_source=web&url=https%3A%2F%2Fevil.test&" + VALID));
    }
    @Test public void rejectsMissingInvalidOrAmbiguousCredentials() {
        for (String value : new String[]{"", "url=https://evil.test", VALID + "&mecan_ticket=" + ID,
            VALID + "&mecan_code=" + CODE, VALID.replace(ID, "../MCN"), VALID.replace(CODE, "short"),
            VALID + "%", "mecan_ticket=%ZZ&mecan_code=" + CODE, "x".repeat(1025)}) {
            assertNull(value, InstallTicketLink.fromReferrer(value));
        }
        assertNull(InstallTicketLink.fromReferrer(null));
    }
}
