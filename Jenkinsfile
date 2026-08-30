pipeline {

    agent any

    environment {
        DOCKER_IMAGE = 'sathish75/cp-mapping-tracker'
    }

    stages {

        stage('Checkout') {
            steps {
                checkout scm
            }
        }

        stage('Build Docker Image') {
            steps {
                bat 'docker build -t %DOCKER_IMAGE%:latest .'
            }
        }

        stage('Login to Docker Hub') {
            steps {
                withCredentials([
                    usernamePassword(
                        credentialsId: 'dockerhub-credentials',
                        usernameVariable: 'DOCKER_USERNAME',
                        passwordVariable: 'DOCKER_PASSWORD'
                    )
                ]) {
                    bat 'docker login -u "%DOCKER_USERNAME%" -p "%DOCKER_PASSWORD%"'
                }
            }
        }

        stage('Push Docker Image') {
            steps {
                bat 'docker push %DOCKER_IMAGE%:latest'
            }
        }

        stage('Deploy') {
            steps {
                bat '''
                    docker stop cp-tracker-container
                    if %ERRORLEVEL% EQU 0 docker rm cp-tracker-container

                    docker pull %DOCKER_IMAGE%:latest

                    docker run -d -p 3001:3001 --name cp-tracker-container %DOCKER_IMAGE%:latest
                '''
            }
        }
    }
}
