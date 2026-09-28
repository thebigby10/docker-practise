package com.example.notes;

import java.util.List;
import java.util.Map;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@SpringBootApplication
@RestController
@RequestMapping("/api/notes")
public class NotesApplication {

    private final JdbcClient jdbc;

    NotesApplication(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    public static void main(String[] args) {
        SpringApplication.run(NotesApplication.class, args);
    }

    @GetMapping
    List<Map<String, Object>> list() {
        return jdbc.sql("SELECT id, body FROM notes ORDER BY id").query().listOfRows();
    }

    @PostMapping
    Map<String, Object> create(@RequestBody Map<String, String> in) {
        return jdbc.sql("INSERT INTO notes (body) VALUES (?) RETURNING id, body")
                .param(in.get("body"))
                .query()
                .singleRow();
    }
}
