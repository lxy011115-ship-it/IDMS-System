import java.util.TreeSet;
public final class EnvironmentViewV2 {
  public static void main(String[] args) {
    if (args.length != 3) throw new IllegalArgumentException("EXPECTED_FIXED_PATHS");
    System.out.println("ENV_KEYS=" + String.join(",", new TreeSet<>(System.getenv().keySet())));
    String environmentHome = System.getenv("HOMEDRIVE") == null ? System.getenv("HOME") : System.getenv("HOMEDRIVE") + System.getenv("HOMEPATH");
    System.out.println("ENVIRONMENT_HOME_MATCH=" + args[0].equals(environmentHome));
    System.out.println("USER_HOME_MATCH=" + args[0].equals(System.getProperty("user.home")));
    System.out.println("TMP_MATCH=" + args[1].equals(System.getProperty("java.io.tmpdir")));
    System.out.println("READER_CONFIG_MATCH=" + args[2].equals(System.getenv("IDMS_WORKFLOW_READER_CONFIG")));
    System.out.println("UTF8=" + "UTF-8".equals(System.getProperty("file.encoding")));
    System.out.println("UTC=" + "UTC".equals(System.getProperty("user.timezone")));
    System.out.println("NO_SYSTEM_PROXIES=" + "false".equals(System.getProperty("java.net.useSystemProxies")));
    System.out.println("HEADLESS=" + "true".equals(System.getProperty("java.awt.headless")));
    System.out.println("INJECTION_ABSENT=" + (System.getProperty("idms.fixture.injected") == null));
  }
}
