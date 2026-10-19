plugins { kotlin("jvm") version "2.3.0" }

repositories { mavenCentral() }

dependencies {
    implementation("org.json:json:20240303")
    testImplementation(kotlin("test"))
}

kotlin { jvmToolchain(17) }

tasks.register<JavaExec>("syntheticTest") {
    dependsOn(tasks.named("testClasses"))
    classpath = sourceSets.test.get().runtimeClasspath
    mainClass.set("com.geops.agent.SyntheticTestsKt")
}
