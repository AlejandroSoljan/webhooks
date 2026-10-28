package ar.com.asisto.mecan;
import org.junit.Test;
import static org.junit.Assert.*;

public class MecanLinksTest {
    @Test public void acceptsBothDomainsWithoutLosingTicket() {
        for(String host:new String[]{"asistobot.com.ar","www.asistobot.com.ar","asisto.com.ar","www.asisto.com.ar"}) {
            assertEquals("https://asistobot.com.ar/customer-app/MCN?claim=abc#code=token",
                MecanLinks.canonicalTicketUrl("https://"+host+"/customer-app/MCN?claim=abc#code=token"));
        }
    }
    @Test public void rejectsForeignHostsTenantsAndAmbiguousPaths() {
        for(String url:new String[]{"https://evil.test/customer-app/MCN","http://asisto.com.ar/customer-app/MCN",
            "https://asisto.com.ar/customer-app/OTHER","https://asisto.com.ar/customer-app/MCN-falso",
            "https://asisto.com.ar:444/customer-app/MCN","https://user@asisto.com.ar/customer-app/MCN"}) {
            assertNull(MecanLinks.canonicalTicketUrl(url));
        }
    }
}
