package ar.com.asisto.mecan;
import org.junit.Test;
import static org.junit.Assert.*;
public class DeviceIdentityTest {
    @Test public void stableButScopedToPackageAndDevice() {
        String key=DeviceIdentity.key("1234567890abcdef","ar.com.asisto.mecan");
        assertTrue(key.matches("[a-f0-9]{64}"));
        assertEquals(key,DeviceIdentity.key("1234567890ABCDEF","ar.com.asisto.mecan"));
        assertNotEquals(key,DeviceIdentity.key("abcdef1234567890","ar.com.asisto.mecan"));
        assertNotEquals(key,DeviceIdentity.key("1234567890abcdef","another.app"));
    }
    @Test public void unavailableOrKnownBrokenIdDoesNotLinkUnrelatedDevices() {
        for(String id:new String[]{null,"","unknown","9774d56d682e549c","0000000000000000"})assertEquals("",DeviceIdentity.key(id,"app"));
    }
}
